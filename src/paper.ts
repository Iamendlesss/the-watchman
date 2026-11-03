import { DiscordNotifier } from "./alerts/discord";
import { NO_ALERTS, PaperAlerts, type Sender, type TradeAlerts } from "./alerts/paper-alerts";
import { PaperExecutor, type Quote } from "./executor";
import { tryOpen, type Deps } from "./engine";
import type { Config } from "./config";
import type { Fill, Ledger, PositionRow } from "./ledger";
import { runScan, type PassContext, type TickContext } from "./scan";
import type { LaunchTracker, TokenState } from "./scanner/tracker";
import { drawdownBreached, drawdownFloorSol, drawdownHaltReason } from "./risk";
import { decideExit } from "./strategy/exits";

const sol = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(4)}`;
const clock = () => new Date().toTimeString().slice(0, 8);

/**
 * Paper trader for the snipe strategy on pump.fun bonding curves. It sits on top of the scan: every coin that
 * passes the gate is offered to the risk manager, and coins we hold stay streamed and are managed by the exit
 * rules. Fills are simulated with the bonding curve's own math, the measured venue fee, and network fees.
 * Nothing here can spend real money.
 */
export class PaperTrader {
  readonly stats = { entered: 0, skipped: 0, exits: 0, partials: 0, restartCloses: 0 };
  private tracker: LaunchTracker | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly ledger: Ledger,
    private readonly executor: PaperExecutor,
    private readonly log: (m: string) => void = (m) => console.log(m),
    private readonly alerts: TradeAlerts = NO_ALERTS,
  ) {}

  private get deps(): Deps {
    return { cfg: this.cfg, ledger: this.ledger, executor: this.executor };
  }

  /** Current market for a coin, straight from its bonding curve reserves. */
  quoteFor(state: TokenState): Quote | null {
    if (state.vToken <= 0n || state.vSol <= 0n) return null;
    const vSol = Number(state.vSol) / 1e9;
    const fee = state.lastFeeBps > 0 ? state.lastFeeBps / 10_000 : this.cfg.paper.defaultTradeFeePct;
    return {
      mint: state.mint,
      symbol: state.symbol,
      midPriceSol: vSol / (Number(state.vToken) / 1e6),
      liquiditySol: vSol,
      tradeFeePct: fee,
    };
  }

  /** What an open position could actually be sold for, per token, after impact and fees. Used to value equity. */
  private executableMark(pos: PositionRow, state: TokenState | undefined): number {
    const q = state ? this.quoteFor(state) : null;
    if (!q) return pos.last_price_sol ?? pos.entry_price_sol;
    const r = this.executor.sell(q, pos.tokens, { closing: true, force: true });
    return r.ok ? (r.fill.solAmount - r.fill.feesSol) / pos.tokens : q.midPriceSol * (1 - this.cfg.risk.maxSlippagePct);
  }

  private marks(tracker: LaunchTracker): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of this.ledger.getOpenPositions()) m.set(p.mint, this.executableMark(p, tracker.get(p.mint)));
    return m;
  }

  /** Positions left open by an earlier run cannot be priced any more, so they are closed at their last saved price minus a haircut. */
  closeOrphans(now: number): number {
    let n = 0;
    for (const pos of this.ledger.getOpenPositions()) {
      const price = (pos.last_price_sol ?? pos.entry_price_sol) * (1 - this.cfg.paper.restartHaircutPct);
      const f = this.cfg.fees;
      const fill: Fill = {
        side: "sell",
        tokens: pos.tokens,
        priceSol: price,
        solAmount: pos.tokens * price,
        feesSol: f.baseFeeSol + f.priorityFeeSol + f.senderTipSol,
        rentSol: -f.ataRentSol,
        slippagePct: this.cfg.paper.restartHaircutPct,
      };
      this.ledger.recordSell(pos.id, now, fill, "closed on restart (price unknown)");
      n++;
    }
    this.stats.restartCloses += n;
    return n;
  }

  /** Called for every coin that passes the gate. Returns true if we took a position (the scan then keeps streaming it). */
  onPass(ctx: PassContext): boolean {
    this.tracker = ctx.tracker;
    const quote = this.quoteFor(ctx.state);
    if (!quote) return false;
    const out = tryOpen(
      this.deps,
      { quote, strategy: "snipe", gateSnapshot: ctx.snap },
      ctx.now,
      this.marks(ctx.tracker),
    );
    if (!out.opened) {
      this.stats.skipped++;
      this.log(`[${clock()}] SKIP    $${ctx.snap.symbol.slice(0, 12)}  ${out.reasons.join("; ")}`);
      this.alerts.blocked(out.reasons, ctx.now);
      return false;
    }
    const pos = this.ledger.getPosition(out.positionId!)!;
    this.ledger.setLastPrice(pos.id, quote.midPriceSol);
    this.stats.entered++;
    this.log(
      `[${clock()}] ENTER   $${ctx.snap.symbol.slice(0, 12)} ${ctx.snap.mint}  ${sol(pos.entry_size_sol)} SOL @ ${quote.midPriceSol.toExponential(3)}, ` +
        `run-up ${ctx.snap.runupMultiple.toFixed(1)}x since launch, fee ${(quote.tradeFeePct! * 100).toFixed(2)}%`,
    );
    this.alerts.opened(pos, ctx.snap);
    return true;
  }

  /** Manage every open position (update its peak and apply the exit rules), then check the drawdown floor. */
  onTick(ctx: TickContext): void {
    this.manage(ctx);
    this.checkFloor(ctx.now);
  }

  /**
   * The drawdown floor is checked on every tick, so the halt and its alert come as soon as equity crosses it,
   * not at the next entry attempt. Open positions are left to their normal exits.
   */
  private checkFloor(now: number): void {
    if (this.ledger.getHalt()) return;
    const eq = this.equityNow();
    const peak = this.ledger.peakEquity(eq, now);
    if (eq > peak) return this.ledger.raisePeakEquity(eq, now);
    if (!drawdownBreached(eq, peak, this.cfg)) return;
    const reason = drawdownHaltReason(eq, peak, this.cfg);
    this.ledger.setHalt(reason, now);
    this.log(`[${clock()}] HALT    ${reason}. No new trades until "npm run resume". Open positions keep their exits.`);
    this.alerts.floorHit(eq, peak, now);
  }

  private manage(ctx: TickContext): void {
    this.tracker = ctx.tracker;
    for (const pos of this.ledger.getOpenPositions()) {
      const state = ctx.tracker.get(pos.mint);
      const quote = state ? this.quoteFor(state) : null;
      if (!state || !quote) {
        if (!state) this.closeOrphan(pos, ctx);
        continue; // no price yet; keep holding
      }
      this.ledger.updatePeak(pos.id, quote.midPriceSol);
      this.ledger.setLastPrice(pos.id, quote.midPriceSol);
      const fresh = this.ledger.getPosition(pos.id)!;
      const snap = ctx.tracker.snapshot(state, ctx.now);
      const d = decideExit(
        {
          strategy: fresh.strategy,
          entryPrice: fresh.entry_price_sol,
          peakPrice: fresh.peak_price_sol,
          price: quote.midPriceSol,
          recoveredInitial: fresh.recovered_initial === 1,
          ageMs: ctx.now - fresh.opened_at,
          creatorSoldPct: snap.creatorSoldPct,
          graduated: state.complete,
        },
        this.cfg,
      );
      if (d.action !== "sell") continue;
      const closing = d.fraction >= 1;
      const tokens = closing ? fresh.tokens : fresh.tokens * d.fraction;
      const res = this.executor.sell(quote, tokens, { closing, force: closing });
      if (!res.ok) continue; // a partial sell blocked by the slippage cap is retried on the next tick
      const o = this.ledger.recordSell(fresh.id, ctx.now, res.fill, d.reason, { markRecoveredInitial: d.markRecovered });
      if (o.closed) {
        this.stats.exits++;
        const closed = this.ledger.getPosition(fresh.id)!;
        this.log(
          `[${clock()}] EXIT    $${fresh.symbol.slice(0, 12)}  ${d.reason}, position P&L ${sol(closed.realized_pnl_sol)} SOL ` +
            `(${((closed.realized_pnl_sol / fresh.cost_basis_sol) * 100).toFixed(0)}% of cost)`,
        );
        this.alerts.closed(closed);
        ctx.forget(fresh.mint);
      } else {
        this.stats.partials++;
        this.log(`[${clock()}] PARTIAL $${fresh.symbol.slice(0, 12)}  ${d.reason}, realized ${sol(o.realizedDeltaSol)} SOL`);
        this.alerts.partial(fresh, d.reason, o.realizedDeltaSol);
      }
    }
  }

  private closeOrphan(pos: PositionRow, ctx: TickContext): void {
    // The coin's state is gone (it should never be); close at the last price with the restart haircut rather than hold blind.
    this.closeOrphans(ctx.now);
    this.log(`[${clock()}] EXIT    $${pos.symbol}  lost track of the coin; closed at last saved price`);
  }

  /** Equity with open positions valued at what a sell would return now (entry price if unknown). */
  equityNow(): number {
    const marks = this.tracker ? this.marks(this.tracker) : new Map<string, number>();
    return this.ledger.equitySol(this.cfg.wallet.startingSol, marks);
  }

  statusLine(): string {
    const eq = this.equityNow();
    const s = this.ledger.summary();
    const peak = this.ledger.getPeakEquity();
    const halt = this.ledger.getHalt();
    return (
      `paper: equity ${sol(eq)} SOL (start ${sol(this.cfg.wallet.startingSol)}), open ${s.openPositions}, closed ${s.closedPositions} ` +
      `(${s.wins}W/${s.losses}L), realized ${sol(s.realizedPnlSol)} SOL` +
      (peak ? `, floor ${sol(drawdownFloorSol(peak.peakSol, this.cfg))} SOL` : "") +
      (halt ? `, HALTED (${halt.reason.split(":")[0]})` : "")
    );
  }

  printSummary(): void {
    const s = this.ledger.summary();
    this.log("\n=== Paper trading summary ===");
    this.log(`Entered ${this.stats.entered}, skipped by risk rules ${this.stats.skipped}, exits ${this.stats.exits}, partial sells ${this.stats.partials}`);
    this.log(`Closed ${s.closedPositions} (${s.wins}W/${s.losses}L), realized P&L ${sol(s.realizedPnlSol)} SOL, fees ${sol(s.feesPaidSol)} SOL`);
    for (const p of this.ledger.getOpenPositions()) {
      this.log(`Still open: $${p.symbol} ${p.mint} (${sol(p.entry_size_sol)} SOL entry). It will be closed at its last saved price if the bot restarts.`);
    }
    this.log("Run `npm run report` for the full breakdown.");
  }
}

export interface PaperOptions {
  minutes: number;
  debug: boolean;
}

/** Discord alerts when they are switched on and DISCORD_WEBHOOK_URL is set; otherwise a sender that does nothing. */
export function defaultNotifier(cfg: Config): DiscordNotifier {
  return new DiscordNotifier(cfg.alerts.enabled ? process.env.DISCORD_WEBHOOK_URL : undefined, {
    log: (m) => console.log(`[${clock()}] ${m}`),
  });
}

export async function runPaper(
  cfg: Config,
  opts: PaperOptions,
  ledger: Ledger,
  notifier: Sender & { flush?: (ms: number) => Promise<void> } = defaultNotifier(cfg),
): Promise<number> {
  const startedAt = Date.now();
  const alerts = new PaperAlerts(notifier, cfg, ledger, startedAt);
  const trader = new PaperTrader(cfg, ledger, new PaperExecutor(cfg), undefined, alerts);
  const orphans = trader.closeOrphans(startedAt);
  console.log(
    `Paper trading (no real money, no keys). Wallet ${sol(cfg.wallet.startingSol)} SOL, ${(cfg.sizing.positionPct * 100).toFixed(0)}% per position, ` +
      `max ${cfg.sizing.maxOpenPositions} open, daily loss halt ${(cfg.risk.dailyLossHaltPct * 100).toFixed(0)}%.`,
  );
  if (orphans) console.log(`Closed ${orphans} position(s) left open by an earlier run, at the last saved price minus ${(cfg.paper.restartHaircutPct * 100).toFixed(0)}%.`);
  console.log(
    notifier.enabled
      ? `Discord alerts: on (trades, halts, stream outages, a heartbeat every ${cfg.alerts.heartbeatHours}h, and a daily report).`
      : "Discord alerts: off (no DISCORD_WEBHOOK_URL, or alerts.enabled is false).",
  );
  const equity = trader.equityNow();
  const peak = ledger.peakEquity(equity, startedAt); // the first run with the floor starts its mark here
  console.log(
    `Drawdown floor: ${sol(drawdownFloorSol(peak, cfg))} SOL, ${(cfg.risk.maxDrawdownPct * 100).toFixed(0)}% below the high-water mark of ${sol(peak)} SOL.`,
  );
  const halt = ledger.getHalt();
  if (halt) console.log(`Trading is HALTED: ${halt.reason}. No new trades until "npm run resume".`);
  alerts.started(equity, orphans, peak, halt?.reason ?? null);
  const code = await runScan(
    cfg,
    { minutes: opts.minutes, debug: opts.debug, ledger },
    {
      onPass: (c) => trader.onPass(c),
      onTick: (c) => {
        trader.onTick(c);
        alerts.tick(c.now, () => trader.equityNow());
      },
      onStreamChange: (down) => alerts.streamChange(down, Date.now()),
      status: () => trader.statusLine(),
      onEnd: () => trader.printSummary(),
    },
  );
  alerts.stopped(Date.now(), trader.stats.entered, trader.stats.exits, trader.equityNow());
  await notifier.flush?.(5000); // give the "stopped" message a moment to go out before the process exits
  return code;
}
