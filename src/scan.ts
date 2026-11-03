import type { Config } from "./config";
import { Ledger } from "./ledger";
import { backfillGap } from "./scanner/backfill";
import { PumpEventDecoder, loadPumpIdl } from "./scanner/events";
import { PUMP_MINT_AUTHORITY } from "./scanner/pda";
import { LaunchTracker, type FeeField, type Snapshot, type TokenState } from "./scanner/tracker";
import { UsageMeter } from "./scanner/usage";
import { RedundantLogStream } from "./scanner/ws";
import { evaluateStreamGate, launchTimeRule } from "./safety/gate";
import { judge, type Verdict } from "./safety/pipeline";
import { TokenBucket } from "./safety/rugcheck";

export interface ScanOptions {
  /** Use Infinity to run until Ctrl+C. */
  minutes: number;
  debug: boolean;
  /** Use an existing ledger. The scan will not close it. */
  ledger?: Ledger;
}

export interface PassContext {
  state: TokenState;
  snap: Snapshot;
  verdict: Verdict;
  now: number;
  tracker: LaunchTracker;
  ledger: Ledger;
}
export interface TickContext {
  now: number;
  tracker: LaunchTracker;
  ledger: Ledger;
  /** Stop streaming a coin and drop its state. */
  forget: (mint: string) => void;
}
export interface ScanHooks {
  /** Called for every coin that passes the gate. Return true to keep streaming and tracking the coin. */
  onPass?: (ctx: PassContext) => boolean;
  /** Called every 2 seconds after the launch checks, e.g. to manage open positions. */
  onTick?: (ctx: TickContext) => void | Promise<void>;
  /** Extra text for the once-a-minute status line. */
  status?: () => string;
  /** The live stream lost its last open connection (true) or got one back (false). */
  onStreamChange?: (allDown: boolean) => void;
  onEnd?: (ctx: { ledger: Ledger }) => void;
}

const clock = () => new Date().toTimeString().slice(0, 8);
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
/** The snapshot values the stream rules look at, kept small for the decisions table. */
export const gateNumbers = (s: Snapshot) => ({
  realSol: round(s.realSol, 2),
  top10Pct: round(s.top10Pct, 4),
  creatorPct: round(s.creatorPct, 4),
  creatorSoldPct: round(s.creatorSoldPct, 4),
  bundledPct: round(s.bundledPct, 4),
  uniqueBuyers: s.uniqueBuyers,
  buyCount: s.buyCount,
  sellCount: s.sellCount,
  runupMultiple: round(s.runupMultiple, 2),
});

/**
 * Read-only scan, built to stay inside the Helius free plan. Instead of streaming every pump.fun transaction,
 * it (1) subscribes only to launch transactions, (2) subscribes to a coin's own bonding curve only if the coin
 * passes the launch-time rules, (3) stops streaming coins that show no traction after the early check, and
 * (4) backfills the first slots' trades over RPC only for coins that reach the final gate.
 * It never trades and never loads a wallet key.
 */
export async function runScan(cfg: Config, opts: ScanOptions, hooks: ScanHooks = {}): Promise<number> {
  const heliusKey = (process.env.HELIUS_API_KEY ?? "").trim();
  if (!heliusKey) {
    console.error("HELIUS_API_KEY is empty. Fill it in .env first (npm run check-env).");
    return 1;
  }
  // STREAM_WS_URL lets the live stream come from another provider (it is used as given, and Helius's key is never
  // sent to it). Helius is then only used for the few RPC calls (backfill and mint checks).
  const customStream = (process.env.STREAM_WS_URL ?? "").trim();
  const wsUrl = customStream || `${cfg.scanner.heliusWsBase}/?api-key=${heliusKey}`;
  const rpcUrl = `${cfg.scanner.heliusRpcBase}/?api-key=${heliusKey}`;
  const rugKey = (process.env.RUGCHECK_API_KEY ?? "").trim() || undefined;

  const ledger = opts.ledger ?? new Ledger(cfg.paths.dbPath);
  const ownsLedger = !opts.ledger;
  const decoder = new PumpEventDecoder(loadPumpIdl());
  const tracker = new LaunchTracker(cfg.scanner);
  const usage = new UsageMeter(Date.now, !customStream);
  const utcDay = () => new Date().toISOString().slice(0, 10);
  const budget = cfg.scanner.dailyCreditBudget;
  if (ledger.creditsUsed(utcDay()) >= budget) {
    console.log(`Today's Helius credit budget (${budget.toLocaleString()}) is already used up. Try again tomorrow (UTC), or raise scanner.dailyCreditBudget.`);
    if (ownsLedger) ledger.close();
    return 0;
  }
  const bucket = new TokenBucket(cfg.scanner.rugchecksPerMinute);

  // Every call to our Helius RPC endpoint is counted; calls to other hosts (RugCheck) are not.
  const countingFetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(url).startsWith(cfg.scanner.heliusRpcBase)) usage.addRpc(1);
    return fetch(url, init);
  }) as typeof fetch;

  const stats = {
    launches: 0,
    skipped: new Map<string, number>(),
    earlyCut: 0,
    judged: 0,
    passed: 0,
    backfilled: 0,
    backfilledTxs: 0,
    rejectedByStage: { stream: 0, mint: 0, rugcheck: 0 } as Record<string, number>,
    ruleHits: new Map<string, number>(),
    rugcheckKeys: new Set<string>(),
    extensions: new Set<string>(),
    notes: new Map<string, number>(),
  };
  const passes: string[] = [];
  /** Signatures already applied per tracked coin, so live and backfilled copies of a trade are never double counted. */
  const seen = new Map<string, Set<string>>();
  const firstLive = new Map<string, string>();

  console.log(`Scanning pump.fun launches for ${opts.minutes} minute(s). Read-only: no trades, no wallet key.`);
  console.log(
    `Live stream: ${customStream ? "custom provider (STREAM_WS_URL)" : "Helius"}. Helius credits used today by this bot: ${Math.round(ledger.creditsUsed(utcDay())).toLocaleString()} of ${budget.toLocaleString()}.`,
  );
  console.log(
    `Coins with no traction after ${cfg.scanner.earlyCheckSeconds}s are dropped; the rest are judged at ${cfg.scanner.observationSeconds}s.\n`,
  );

  const forget = (mint: string) => {
    stream.unsubscribe(`tok:${mint}`);
    tracker.release(mint);
    seen.delete(mint);
    firstLive.delete(mint);
  };

  const applyToken = (mint: string, slot: number, logs: string[], signature: string) => {
    const set = seen.get(mint);
    if (!set || set.has(signature)) return;
    set.add(signature);
    const now = Date.now();
    for (const ev of decoder.decodeLogs(logs)) tracker.onEvent(ev, slot, now, signature);
  };

  const stream: RedundantLogStream = new RedundantLogStream({
    url: wsUrl,
    connections: customStream ? cfg.scanner.streamConnections : 1,
    staggerMs: cfg.scanner.streamStaggerSeconds * 1000,
    stallMs: cfg.scanner.stallSeconds * 1000,
    onBytes: (n) => usage.add(n),
    onStatus: (m) => console.log(`[${clock()}] stream: ${m}`),
    onSubscribed: (id, label) => {
      if (id === "launches") console.log(`[${clock()}] stream: ${label}subscribed to launches`);
    },
    onBlindChange: (down) => hooks.onStreamChange?.(down),
  });

  stream.subscribe("launches", PUMP_MINT_AUTHORITY, (slot, logs, signature) => {
    const now = Date.now();
    for (const ev of decoder.decodeLogs(logs)) {
      if (ev.name !== "CreateEvent") {
        tracker.onEvent(ev, slot, now, signature); // the creator's own first buy rides in the create transaction
        continue;
      }
      const c = ev.data;
      stats.launches++;
      const skip = launchTimeRule(c, cfg);
      if (skip) {
        stats.skipped.set(skip, (stats.skipped.get(skip) ?? 0) + 1);
        ledger.logDecision({ ts: now, mint: c.mint, action: "scan_reject", reason: skip });
        continue;
      }
      tracker.onEvent(ev, slot, now, signature);
      seen.set(c.mint, new Set([signature]));
      stream.subscribe(`tok:${c.mint}`, c.bondingCurve, (s, l, sig) => {
        if (!firstLive.has(c.mint)) firstLive.set(c.mint, sig);
        applyToken(c.mint, s, l, sig);
      });
    }
  });

  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();

      // Early check: stop streaming coins that have not found any buyers.
      for (const t of tracker.dueEarly(now, cfg.scanner.earlyCheckSeconds)) {
        const s = tracker.snapshot(t, now);
        if (s.uniqueBuyers < cfg.scanner.earlyMinBuyers || s.realSol < cfg.scanner.earlyMinSol) {
          stats.earlyCut++;
          ledger.logDecision({ ts: now, mint: t.mint, action: "scan_reject", reason: "EARLY_NO_TRACTION" });
          forget(t.mint);
        } else {
          tracker.markEarlyChecked(t.mint);
        }
      }

      // Final judgement.
      for (const t of tracker.due(now)) {
        tracker.markEvaluated(t.mint);
        let snap = tracker.snapshot(t, now);
        let keep = false;
        try {
          if (evaluateStreamGate(snap, cfg).pass && cfg.scanner.backfillMaxTxs > 0) {
            // A serious candidate: fetch the first slots' trades we could not have streamed, then re-judge.
            const set = seen.get(t.mint) ?? new Set<string>();
            const gap = await backfillGap({
              rpcUrl,
              bondingCurve: t.bondingCurve,
              createSignature: t.createSignature,
              beforeSignature: firstLive.get(t.mint),
              maxTxs: cfg.scanner.backfillMaxTxs,
              seen: set,
              fetchFn: countingFetch,
            });
            stats.backfilled++;
            stats.backfilledTxs += gap.txs.length;
            for (const tx of gap.txs) {
              set.add(tx.signature);
              for (const ev of decoder.decodeLogs(tx.logs)) tracker.onEvent(ev, tx.slot, now, tx.signature);
            }
            snap = tracker.snapshot(t, now);
          }
          const v: Verdict = await judge(snap, { cfg, rpcUrl, bucket, rugcheckKey: rugKey, fetchFn: countingFetch });
          stats.judged++;
          for (const n of v.notes) stats.notes.set(n, (stats.notes.get(n) ?? 0) + 1);
          v.rugcheck?.topLevelKeys.forEach((k) => stats.rugcheckKeys.add(k));
          v.mintInfo?.extensions.forEach((e) => stats.extensions.add(e));
          if (v.pass) {
            stats.passed++;
            const line =
              `PASS    $${snap.symbol.slice(0, 12)} ${snap.mint}  buyers ${snap.uniqueBuyers}, curve ${snap.realSol.toFixed(1)} SOL, ` +
              `top10 ${pct(snap.top10Pct)}, bundled ${pct(snap.bundledPct)}`;
            passes.push(line);
            console.log(`[${clock()}] ${line}`);
            ledger.logDecision({
              ts: now, mint: snap.mint, action: "scan_pass", reason: "passed gate",
              details: { symbol: snap.symbol, snapshot: snap, notes: v.notes },
            });
            keep = hooks.onPass?.({ state: t, snap, verdict: v, now, tracker, ledger }) ?? false;
          } else {
            stats.rejectedByStage[v.stage] = (stats.rejectedByStage[v.stage] ?? 0) + 1;
            for (const f of v.failed) stats.ruleHits.set(f, (stats.ruleHits.get(f) ?? 0) + 1);
            const why = v.checks.filter((c) => !c.passed).map((c) => `${c.rule}(${c.value} vs ${c.limit})`).join("; ");
            if (opts.debug) console.log(`[${clock()}] REJECT  $${snap.symbol.slice(0, 12)}  ${why}`);
            // The numbers behind the verdict, so later analysis can ask what a different threshold would have let through.
            ledger.logDecision({
              ts: now, mint: snap.mint, action: "scan_reject", reason: v.failed.join(","),
              details: { stage: v.stage, ...gateNumbers(snap) },
            });
          }
        } catch {
          /* a failure on one coin must never stop the scan */
        }
        // Coins are forgotten after their verdict unless a hook (the paper trader) took a position and keeps them.
        if (!keep) forget(t.mint);
      }
      await hooks.onTick?.({ now: Date.now(), tracker, ledger, forget });
    } finally {
      busy = false;
    }
  };

  // 500ms, not 2s: open-position management (stop-loss, trailing stop, etc.) needs no network call, so
  // checking often costs nothing and shrinks how far price can move past a trigger before we react to it.
  const tickTimer = setInterval(() => void tick(), 500);
  const statusTimer = setInterval(() => {
    const u = usage.report();
    console.log(
      `[${clock()}] launches ${stats.launches}, dropped early ${stats.earlyCut}, judged ${stats.judged}, passed ${stats.passed}, ` +
        `streaming ${stream.activeSubscriptions - 1} coins, data ${u.megabytes.toFixed(1)} MB, ` +
        `stream drops ${stream.reconnects} (blind ${Math.round(stream.blindMs / 1000)}s), RPC calls ${u.rpcCalls}, decode errors ${decoder.stats.errors}` +
        (hooks.status ? `\n${" ".repeat(11)}${hooks.status()}` : ""),
    );
  }, 60_000);

  stream.start();
  let budgetHit = false;
  let counted = 0; // credits already written to the ledger for today
  await new Promise<void>((resolve) => {
    // Credit guard: record what this run has used so far, and stop once today's budget is spent.
    const guard = setInterval(() => {
      const total = usage.report().creditsUsed;
      ledger.addCredits(utcDay(), total - counted);
      counted = total;
      if (ledger.creditsUsed(utcDay()) >= budget) {
        budgetHit = true;
        finish();
      }
    }, 5000);
    const end = Number.isFinite(opts.minutes) ? setTimeout(finish, opts.minutes * 60_000) : undefined;
    let done = false;
    // Ctrl+C (SIGINT), closing the Terminal window (SIGHUP) and `kill` (SIGTERM) all end the run cleanly, so the
    // summary prints and the paper trader can send its "stopped" alert.
    const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
    function finish(): void {
      if (done) return; // the timer, the budget guard and a signal can all fire; only the first one runs
      done = true;
      clearTimeout(end);
      clearInterval(guard);
      for (const s of signals) process.off(s, finish);
      resolve();
    }
    for (const s of signals) process.once(s, finish);
  });
  stream.stop();
  clearInterval(tickTimer);
  clearInterval(statusTimer);
  await tick();
  ledger.addCredits(utcDay(), usage.report().creditsUsed - counted); // include the last requests

  const u = usage.report();
  if (budgetHit) console.log(`\nStopped early: today's Helius credit budget (${budget.toLocaleString()}) was reached.`);
  const skippedTotal = [...stats.skipped.values()].reduce((a, b) => a + b, 0);
  console.log("\n=== Scan report ===");
  console.log(`Ran for:            ${(u.seconds / 60).toFixed(1)} min`);
  const blindSec = stream.blindMs / 1000;
  console.log(
    `Stream:             ${stream.connections} connection(s), ${stream.reconnects} drop(s), blind ${blindSec.toFixed(0)}s` +
      (u.seconds > 0 ? ` (${pct(blindSec / u.seconds)} of the run with no connection open)` : ""),
  );
  console.log(`Launches seen:      ${stats.launches}`);
  console.log(
    `Skipped at launch:  ${skippedTotal}${skippedTotal ? ` (${[...stats.skipped.entries()].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`,
  );
  console.log(`Dropped early:      ${stats.earlyCut} (no traction after ${cfg.scanner.earlyCheckSeconds}s)`);
  console.log(`Judged / passed:    ${stats.judged} / ${stats.passed}${stats.judged ? ` (${pct(stats.passed / stats.judged)})` : ""}`);
  console.log(
    `Rejected at stage:  stream ${stats.rejectedByStage.stream ?? 0}, mint check ${stats.rejectedByStage.mint ?? 0}, RugCheck ${stats.rejectedByStage.rugcheck ?? 0}`,
  );
  const rules = [...stats.ruleHits.entries()].sort((a, b) => b[1] - a[1]);
  if (rules.length) console.log(`Rules that rejected: ${rules.map(([r, n]) => `${r} ${n}`).join(", ")}`);
  console.log(`Backfilled:         ${stats.backfilled} coins, ${stats.backfilledTxs} early trades recovered`);
  console.log(`Events decoded:     ${decoder.stats.events}, decode errors ${decoder.stats.errors}`);
  const fee = median(tracker.feeBpsSeen);
  console.log(
    `Median trade fees:  ${fee === null ? "n/a" : `${fee} bps (${(fee / 100).toFixed(2)}%) per trade, protocol + creator`}`,
  );
  console.log("\nHelius credit use:");
  console.log(
    `  stream: ${u.megabytes.toFixed(1)} MB in ${u.messages} messages = ${Math.round(u.streamCredits).toLocaleString()} credits` +
      (customStream ? " (custom provider: no Helius credits)" : ""),
  );
  console.log(`  RPC:    ${u.rpcCalls} calls = ${u.rpcCredits.toLocaleString()} credits (assuming 1 credit per call)`);
  console.log(
    `  at this rate ~${Math.round(u.creditsPerMonth).toLocaleString()} credits/month vs ${u.freePlanCredits.toLocaleString()} on the free plan ` +
      `(${(u.fractionOfFreePlan * 100).toFixed(0)}%)`,
  );
  if (opts.debug) {
    console.log("\nDebug:");
    console.log(
      `  stream notifications: ${stream.notifications}, of which failed transactions dropped: ${stream.failedDropped} ` +
        `(${stream.notifications ? pct(stream.failedDropped / stream.notifications) : "n/a"}), ` +
        `duplicates from the extra connection(s) dropped: ${stream.duplicatesDropped}`,
    );
    console.log(`  pump events ignored: ${[...decoder.stats.ignored.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
    const fields = (Object.keys(tracker.feeFieldSamples) as FeeField[])
      .map((k) => `${k} ${median(tracker.feeFieldSamples[k]) ?? "n/a"}`)
      .join(", ");
    console.log(`  median fee fields (bps): ${fields}`);
    console.log(`  RugCheck response keys: ${[...stats.rugcheckKeys].join(", ") || "none seen"}`);
    console.log(`  Token extensions seen: ${[...stats.extensions].join(", ") || "none"}`);
    for (const [n, c] of stats.notes) console.log(`  note x${c}: ${n}`);
  }
  if (passes.length) {
    console.log(`\nLast passes (up to 10):`);
    for (const p of passes.slice(-10)) console.log(`  ${p}`);
  }
  hooks.onEnd?.({ ledger });
  if (ownsLedger) ledger.close();
  return 0;
}
