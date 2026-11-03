import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { PaperExecutor } from "../src/executor";
import { Ledger } from "../src/ledger";
import type { TradeAlerts } from "../src/alerts/paper-alerts";
import { PaperTrader } from "../src/paper";
import type { PassContext, TickContext } from "../src/scan";
import { LaunchTracker } from "../src/scanner/tracker";
import { SUPPLY, createEv, pk, tradeEv } from "./helpers";

const VT = 1_000_000_000_000_000n; // virtual token reserves, held fixed so price is set by virtual SOL alone
const vSolFor = (price: number) => BigInt(Math.round(price * 1e18)); // lamports for a price in SOL per whole token
// A coin that has passed the gate has real SOL in its curve: about 60 SOL of virtual reserves at this price.
const P0 = 6e-8;
const T0 = Date.UTC(2026, 8, 21, 12);
const MIN = 60_000;

function world(over: object = {}) {
  const cfg = parseConfig({ wallet: { startingSol: 3.75 }, ...over });
  const ledger = new Ledger(":memory:");
  const tracker = new LaunchTracker(cfg.scanner);
  const logs: string[] = [];
  const forgotten: string[] = [];
  const alerted: string[] = [];
  const alerts: TradeAlerts = {
    opened: (p) => alerted.push(`opened ${p.symbol}`),
    partial: (p, reason) => alerted.push(`partial ${p.symbol} ${reason}`),
    closed: (p) => alerted.push(`closed ${p.symbol} ${p.exit_reason}`),
    blocked: (reasons) => alerted.push(`blocked ${reasons.map((r) => r.split(":")[0]).join(",")}`),
    floorHit: (eq, peak) => alerted.push(`floor ${eq.toFixed(2)} ${peak.toFixed(2)}`),
  };
  const trader = new PaperTrader(cfg, ledger, new PaperExecutor(cfg), (m) => logs.push(m), alerts);
  let slot = 1000;

  /** A coin that has launched, gathered buyers, and sits at `price`. */
  function launch(n: number, opts: { price?: number; devBuys?: bigint } = {}) {
    const mint = pk(n), dev = pk(n + 5000);
    const price = opts.price ?? P0;
    tracker.onEvent(createEv(mint, dev, { virtual_sol_reserves: vSolFor(price), virtual_token_reserves: VT }), ++slot, T0);
    if (opts.devBuys) tracker.onEvent(tradeEv(mint, dev, true, opts.devBuys, 1n, reserves(price)), slot, T0);
    for (let i = 0; i < 6; i++) tracker.onEvent(tradeEv(mint, pk(n + 100 + i), true, SUPPLY / 100n, 1n, reserves(price)), ++slot, T0 + 1000);
    return { mint, dev };
  }
  const reserves = (price: number) => ({
    virtual_sol_reserves: vSolFor(price),
    virtual_token_reserves: VT,
    real_sol_reserves: 6_000_000_000n,
    fee_basis_points: 95n,
    creator_fee_basis_points: 30n,
  });
  /** Move a coin's price by feeding it a trade with new virtual reserves. */
  const setPrice = (mint: string, price: number, extra: { user?: string; isBuy?: boolean; tokens?: bigint } = {}) =>
    tracker.onEvent(tradeEv(mint, extra.user ?? pk(9999), extra.isBuy ?? true, extra.tokens ?? 1000n, 1n, reserves(price)), ++slot, T0 + 5000);

  const passCtx = (mint: string, now: number): PassContext => {
    const state = tracker.get(mint)!;
    return { state, snap: tracker.snapshot(state, now), verdict: { pass: true, stage: "all", failed: [], checks: [], notes: [] }, now, tracker, ledger };
  };
  const tickCtx = (now: number): TickContext => ({ now, tracker, ledger, forget: (m) => { forgotten.push(m); tracker.release(m); } });
  const enter = (mint: string, now = T0 + 180_000) => trader.onPass(passCtx(mint, now));
  const tick = (now: number) => trader.onTick(tickCtx(now));
  return { cfg, ledger, tracker, trader, logs, forgotten, alerted, launch, setPrice, enter, tick, reserves };
}

describe("paper trader", () => {
  it("enters at 3% of the wallet and holds the coin", () => {
    const w = world();
    const { mint } = w.launch(1);
    expect(w.enter(mint)).toBe(true);
    const pos = w.ledger.getOpenPositions()[0]!;
    expect(pos.strategy).toBe("snipe");
    // 3% of 3.75 SOL, plus network fees; the venue fee comes out of the swap amount
    expect(pos.cost_basis_sol).toBeCloseTo(3.75 * 0.03 + 0.00051, 6);
    expect(pos.entry_size_sol).toBeCloseTo(3.75 * 0.03 * (1 - 0.0125), 6);
    expect(w.logs.join("\n")).toMatch(/ENTER .* fee 1\.25%/);
  });

  it("sells half at 2x to recover the stake, then a 25% trailing stop closes the rest at a profit", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    const id = w.ledger.getOpenPositions()[0]!.id;
    w.setPrice(mint, P0 * 2.3);
    w.tick(T0 + 200_000);
    let p = w.ledger.getPosition(id)!;
    expect(p.status).toBe("open");
    expect(p.recovered_initial).toBe(1);
    expect(p.realized_pnl_sol).toBeGreaterThan(0.03);
    expect(p.tokens / p.tokens_initial).toBeCloseTo(0.5, 6);
    w.setPrice(mint, P0 * 3.4); // new peak
    w.tick(T0 + 210_000);
    expect(w.ledger.getPosition(id)!.status).toBe("open");
    w.setPrice(mint, P0 * 2.5); // 26% off the 3.4x peak
    w.tick(T0 + 220_000);
    p = w.ledger.getPosition(id)!;
    expect(p.status).toBe("closed");
    expect(p.exit_reason).toBe("trailing stop");
    expect(p.realized_pnl_sol).toBeGreaterThan(0.1);
    expect(w.forgotten).toEqual([mint]);
    // cash reconciles exactly: start + realized P&L (the token-account rent came back)
    expect(w.ledger.cashSol(3.75)).toBeCloseTo(3.75 + p.realized_pnl_sol, 9);
  });

  it("reports each buy, partial sell, close and risk block to the alerts", () => {
    const w = world();
    const a = w.launch(1);
    w.enter(a.mint);
    w.setPrice(a.mint, P0 * 2.3);
    w.tick(T0 + 200_000);
    w.setPrice(a.mint, P0 * 1.5);
    w.tick(T0 + 210_000);
    for (let i = 2; i <= 6; i++) w.enter(w.launch(i).mint); // the fifth open position is one too many
    expect(w.alerted).toEqual([
      "opened TEST",
      "partial TEST initial recovery at 2x",
      "closed TEST trailing stop",
      "opened TEST",
      "opened TEST",
      "opened TEST",
      "opened TEST",
      "blocked MAX_POSITIONS",
    ]);
  });

  it("halts at the drawdown floor on the next tick, while open positions keep their exits", () => {
    const w = world();
    const a = w.launch(1);
    w.enter(a.mint);
    w.tick(T0 + 190_000); // seeds the high-water mark at today's equity
    expect(w.ledger.getHalt()).toBeNull();
    w.ledger.resetPeakEquity(6, T0); // equity of about 3.75 SOL is now 37.5% below a 6 SOL mark
    w.tick(T0 + 195_000);
    expect(w.ledger.getHalt()?.reason).toMatch(/^drawdown floor: equity 3\.\d{4} SOL is 37\.\d% below the high-water mark of 6\.0000 SOL/);
    expect(w.alerted.at(-1)).toMatch(/^floor 3\.\d\d 6\.00$/);
    expect(w.logs.at(-1)).toMatch(/HALT {4}drawdown floor/);
    expect(w.trader.statusLine()).toMatch(/floor 4\.2000 SOL, HALTED \(drawdown floor\)/);
    // No new trades...
    expect(w.enter(w.launch(2).mint)).toBe(false);
    expect(w.alerted.at(-1)).toBe("blocked HALTED");
    // ...but the open position still exits on its own rules.
    w.setPrice(a.mint, P0 * 0.69);
    w.tick(T0 + 200_000);
    expect(w.ledger.getPosition(1)!.exit_reason).toBe("hard stop-loss");
    expect(w.alerted.filter((x) => x.startsWith("floor"))).toHaveLength(1); // the floor alert is sent once
  });

  it("raises the high-water mark as equity makes new highs", () => {
    const w = world();
    const a = w.launch(1);
    w.enter(a.mint);
    w.tick(T0 + 190_000);
    const before = w.ledger.getPeakEquity()!.peakSol;
    w.setPrice(a.mint, P0 * 1.8); // up, but below the 2x partial sell
    w.tick(T0 + 195_000);
    expect(w.ledger.getPeakEquity()!.peakSol).toBeGreaterThan(before);
  });

  it("stops out at 30% below entry, and the real loss is larger than 30% because of costs", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    const cost = w.ledger.getOpenPositions()[0]!.cost_basis_sol;
    w.setPrice(mint, P0 * 0.69);
    w.tick(T0 + 200_000);
    const p = w.ledger.getOpenPositions();
    expect(p).toHaveLength(0);
    const closed = w.ledger.getPosition(1)!;
    expect(closed.exit_reason).toBe("hard stop-loss");
    const lossPct = -closed.realized_pnl_sol / cost;
    expect(lossPct).toBeGreaterThan(0.31);
    expect(lossPct).toBeLessThan(0.5);
  });

  it("exits when the creator dumps their holdings", () => {
    const w = world();
    const devBuy = SUPPLY / 50n;
    const { mint, dev } = w.launch(1, { devBuys: devBuy });
    w.enter(mint);
    w.setPrice(mint, P0, { user: dev, isBuy: false, tokens: (devBuy * 60n) / 100n });
    w.tick(T0 + 200_000);
    expect(w.ledger.getPosition(1)!.exit_reason).toBe("creator dump");
  });

  it("exits when the coin graduates from the bonding curve", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    w.tracker.onEvent({ name: "CompleteEvent", data: { mint } }, 5000, T0 + 6000);
    w.tick(T0 + 200_000);
    expect(w.ledger.getPosition(1)!.exit_reason).toBe("graduated");
  });

  it("time-stops a coin that goes nowhere", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint, T0 + 180_000);
    w.tick(T0 + 180_000 + 29 * MIN);
    expect(w.ledger.getOpenPositions()).toHaveLength(1);
    w.tick(T0 + 180_000 + 31 * MIN);
    expect(w.ledger.getPosition(1)!.exit_reason).toBe("time stop");
  });

  it("never holds more than 4 positions and records why it turned the fifth down", () => {
    const w = world();
    const results = [1, 2, 3, 4, 5].map((n) => w.enter(w.launch(n).mint));
    expect(results).toEqual([true, true, true, true, false]);
    expect(w.ledger.getOpenPositions()).toHaveLength(4);
    expect(w.logs.join("\n")).toMatch(/SKIP .*MAX_POSITIONS/);
    expect(w.ledger.rejectionCounts()).toEqual([{ reason: "MAX_POSITIONS", count: 1 }]);
  });

  it("skips coins whose round trip would cost more than the cap (a small wallet with fixed fees)", () => {
    const w = world({ wallet: { startingSol: 0.3, minSolReserve: 0.01 } }); // 3% of 0.3 SOL = 0.009 SOL
    const { mint } = w.launch(1);
    expect(w.enter(mint)).toBe(false);
    expect(w.ledger.rejectionCounts()[0]?.reason).toContain("COST_CAP");
  });

  it("values equity at what the position could actually be sold for, not the mid price", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    w.tick(T0 + 181_000); // flat price
    const eq = Number(/equity (-?[\d.]+) SOL/.exec(w.trader.statusLine())![1]);
    expect(eq).toBeLessThan(3.75); // costs are already reflected
    expect(eq).toBeGreaterThan(3.75 - 0.03 * 3.75); // but it is not a total loss
  });

  it("closes positions left open by an earlier run at the last saved price minus a haircut", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    const id = w.ledger.getOpenPositions()[0]!.id;
    w.setPrice(mint, P0 * 1.5);
    w.tick(T0 + 181_000); // saves the last price
    expect(w.trader.closeOrphans(T0 + 999_000)).toBe(1);
    const p = w.ledger.getPosition(id)!;
    expect(p.status).toBe("closed");
    expect(p.exit_reason).toBe("closed on restart (price unknown)");
    expect(w.ledger.cashSol(3.75)).toBeCloseTo(3.75 + p.realized_pnl_sol, 9);
    expect(w.ledger.getOpenPositions()).toHaveLength(0);
  });

  it("holds without a price until the coin's first trade arrives", () => {
    const w = world();
    const { mint } = w.launch(1);
    w.enter(mint);
    w.tick(T0 + 181_000);
    expect(w.ledger.getOpenPositions()).toHaveLength(1);
  });
});
