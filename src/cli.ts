import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { loadConfig, parseConfig, type Config } from "./config";
import { Ledger } from "./ledger";
import { PaperExecutor, type Quote } from "./executor";
import { tryOpen, stopFileExists, buildRiskInputs, resumeTrading, utcDay } from "./engine";
import { drawdownFloorSol } from "./risk";
import { runScan } from "./scan";
import { runPaper } from "./paper";
import { analyzeEntries } from "./analyze";
import { DiscordNotifier } from "./alerts/discord";
import { buildDailyReport } from "./alerts/daily";

dotenv.config({ quiet: true });

const sol = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(4)} SOL`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function checkEnv(): number {
  const vars: { name: string; required: boolean; note: string }[] = [
    { name: "HELIUS_API_KEY", required: true, note: "launch stream, RPC, Sender (needed from phase 2)" },
    { name: "JUPITER_API_KEY", required: true, note: "swap instructions (needed from phase 5)" },
    { name: "DISCORD_WEBHOOK_URL", required: true, note: "alerts and reports (needed from phase 4)" },
    { name: "RUGCHECK_API_KEY", required: false, note: "optional; may not be needed" },
    { name: "STREAM_WS_URL", required: false, note: "optional: WebSocket from another provider for the live stream" },
    { name: "TRADER_PRIVATE_KEY", required: false, note: "must stay empty during paper trading" },
  ];
  console.log("Environment check (values are never printed)\n");
  let problems = 0;
  const envFile = path.resolve(".env");
  if (!fs.existsSync(envFile)) {
    console.log("  !! No .env file found in this folder.");
    problems++;
  } else if (process.platform !== "win32") {
    const mode = fs.statSync(envFile).mode & 0o777;
    if (mode & 0o077) {
      console.log(`  !! .env is readable by other users. Run: chmod 600 .env`);
      problems++;
    }
  }
  for (const v of vars) {
    const val = (process.env[v.name] ?? "").trim();
    const set = val.length > 0;
    let status: string;
    if (v.name === "TRADER_PRIVATE_KEY") {
      status = set ? "SET  <-- should be empty during paper trading" : "empty (correct for now)";
      if (set) problems++;
    } else if (set) {
      status = "set";
    } else {
      status = v.required ? "EMPTY  <-- fill this in" : "empty (ok)";
      if (v.required) problems++;
    }
    console.log(`  ${v.name.padEnd(20)} ${status.padEnd(45)} ${v.note}`);
  }
  console.log(problems === 0 ? "\nAll good." : `\n${problems} thing(s) to fix.`);
  return problems === 0 ? 0 : 1;
}

const signedPct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

function printReport(ledger: Ledger, cfg: Config, title: string): void {
  const s = ledger.summary();
  const equity = ledger.equitySol(cfg.wallet.startingSol);
  console.log(`\n=== ${title} ===`);
  console.log(`Mode:              ${cfg.mode}`);
  console.log(`Starting equity:   ${sol(cfg.wallet.startingSol)}`);
  console.log(`Equity now:        ${sol(equity)} (open positions valued at entry price)`);
  console.log(`Open / closed:     ${s.openPositions} / ${s.closedPositions}`);
  if (s.closedPositions > 0) {
    console.log(`Win rate:          ${pct(s.wins / s.closedPositions)} (${s.wins}W / ${s.losses}L)`);
    console.log(`Avg win / loss:    ${sol(s.avgWinSol)} / ${sol(s.avgLossSol)}  (SOL -- shifts as position size drifts)`);
  }
  console.log(`Realized P&L:      ${sol(s.realizedPnlSol)}`);
  console.log(`Fees paid:         ${sol(s.feesPaidSol)}`);
  for (const [name, v] of Object.entries(s.byStrategy)) {
    console.log(`  ${name.padEnd(9)} closed ${v.closed}, wins ${v.wins}, P&L ${sol(v.realizedPnlSol)}`);
  }
  console.log(`Decisions logged:  ${ledger.countDecisions()}`);

  const printPctSummary = (label: string, p: ReturnType<Ledger["pctSummary"]>) => {
    if (!p) return;
    console.log(
      `${label} (% of cost, size-independent): ${p.trades} trades, win rate ${pct(p.winRatePct)}, ` +
        `avg win ${signedPct(p.avgWinPct)}, avg loss ${signedPct(p.avgLossPct)}, expectancy/trade ${signedPct(p.expectancyPct)}`,
    );
  };
  printPctSummary("Overall", ledger.pctSummary());

  const exits = ledger.exitBreakdown();
  if (exits.length) {
    console.log("Exits by reason (count, avg % of cost, SOL total):");
    for (const e of exits) {
      console.log(`  ${e.reason.padEnd(34)} ${String(e.count).padStart(4)}   avg ${signedPct(e.avgPct).padStart(7)}   P&L ${sol(e.pnlSol)}`);
    }
  }
  const rej = ledger.rejectionCounts();
  if (rej.length) console.log(`Entries turned down: ${rej.map((r) => `${r.reason} ${r.count}`).join(", ")}`);
}

function openLedger(cfg: Config): Ledger {
  return new Ledger(cfg.paths.dbPath);
}

function status(): number {
  const cfg = loadConfig();
  const ledger = openLedger(cfg);
  const now = Date.now();
  const halt = ledger.getHalt();
  const inp = buildRiskInputs({ cfg, ledger, executor: new PaperExecutor(cfg) }, now, new Map());
  console.log(`Mode:             ${cfg.mode}`);
  console.log(`STOP file:        ${stopFileExists(cfg) ? "PRESENT (trading blocked)" : "not present"}`);
  console.log(`Halt:             ${halt ? `ACTIVE: ${halt.reason}. Run "npm run resume" to clear.` : "none"}`);
  console.log(`Equity:           ${sol(inp.equitySol)}  (start of ${utcDay(now)} UTC: ${sol(inp.startOfDayEquitySol)})`);
  console.log(
    `Drawdown floor:   ${sol(drawdownFloorSol(inp.peakEquitySol, cfg))}  (${(cfg.risk.maxDrawdownPct * 100).toFixed(0)}% below the high-water mark of ` +
      `${sol(inp.peakEquitySol)}. Equity is ${((1 - inp.equitySol / inp.peakEquitySol) * 100).toFixed(1)}% below the mark.)`,
  );
  console.log(`Cash:             ${sol(inp.cashSol)}`);
  console.log(`Open positions:   ${inp.openPositions} / ${cfg.sizing.maxOpenPositions}`);
  console.log(`Loss streak:      ${inp.consecutiveLosses}`);
  ledger.close();
  return 0;
}

function resume(): number {
  const cfg = loadConfig();
  const ledger = openLedger(cfg);
  const r = resumeTrading(ledger, cfg, Date.now());
  if (!r.cleared) console.log("No active halt.");
  else {
    console.log(`Halt cleared (${r.cleared}). The bot may open positions again.`);
    if (r.newPeakSol !== undefined) {
      console.log(
        `Drawdown floor reset: the high-water mark is now ${sol(r.newPeakSol)}, so the floor is ${sol(drawdownFloorSol(r.newPeakSol, cfg))}.`,
      );
    }
  }
  ledger.close();
  return 0;
}

/** Parses --since (an ISO date-time, e.g. 2026-09-28T00:00) or --since-hours (a number of hours ago). */
function parseSince(args: string[]): number | undefined {
  const hoursIdx = args.indexOf("--since-hours");
  if (hoursIdx >= 0) {
    const hours = Number(args[hoursIdx + 1]);
    if (Number.isFinite(hours) && hours > 0) return Date.now() - hours * 3_600_000;
  }
  const idx = args.indexOf("--since");
  if (idx >= 0) {
    const ms = Date.parse(args[idx + 1] ?? "");
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function report(args: string[]): number {
  const cfg = loadConfig();
  const ledger = openLedger(cfg);
  printReport(ledger, cfg, "Ledger report (all time)");

  const since = parseSince(args);
  if (since !== undefined) {
    console.log(`\n--- Since ${new Date(since).toISOString()} ---`);
    const p = ledger.pctSummary(since);
    if (!p) {
      console.log("No closed positions in that window yet.");
    } else {
      console.log(
        `${p.trades} trades, win rate ${pct(p.winRatePct)}, avg win ${signedPct(p.avgWinPct)}, ` +
          `avg loss ${signedPct(p.avgLossPct)}, expectancy/trade ${signedPct(p.expectancyPct)}`,
      );
      const exits = ledger.exitBreakdownSince(since);
      console.log("Exits by reason (count, avg % of cost, SOL total):");
      for (const e of exits) {
        console.log(`  ${e.reason.padEnd(34)} ${String(e.count).padStart(4)}   avg ${signedPct(e.avgPct).padStart(7)}   P&L ${sol(e.pnlSol)}`);
      }
    }
  } else {
    console.log(`\n(tip: "npm run report -- --since-hours 24" or "--since 2026-09-28T00:00" compares a window against the all-time figures above)`);
  }
  ledger.close();
  return 0;
}

const MIN_BUCKET_N = 5;
const FIELD_LABELS: Record<string, string> = {
  runupMultiple: "Run-up since launch at entry",
  top10Pct: "Top-10 holder share at entry",
  bundledPct: "Bundled-buy share at entry",
  uniqueBuyers: "Unique buyers at entry",
  realSol: "SOL in curve at entry",
};

/**
 * Buckets every closed trade by what its entry looked like (run-up, holder concentration, bundling, buyer
 * count, curve size) and shows win rate / avg return / hard-stop rate per bucket -- so a pattern in which
 * KINDS of entries fail shows up directly, using trades already collected, no more paper time needed.
 */
function analyze(): number {
  const cfg = loadConfig();
  const ledger = openLedger(cfg);
  const { breakdowns, parsed, skipped } = analyzeEntries(ledger.closedPositionsWithSnapshot());
  ledger.close();

  console.log(`\n=== Entry analysis ===`);
  console.log(`${parsed} closed trades have an entry snapshot to analyze (${skipped} skipped: no snapshot, e.g. from the demo command).`);
  if (parsed === 0) {
    console.log("Nothing to analyze yet -- run some paper trading first.");
    return 0;
  }
  for (const b of breakdowns) {
    console.log(`\n${FIELD_LABELS[b.field] ?? b.field}:`);
    for (const row of b.buckets) {
      const flag = row.count > 0 && row.count < MIN_BUCKET_N ? "  (few trades, low confidence)" : "";
      console.log(
        `  ${row.label.padEnd(8)} n=${String(row.count).padStart(3)}   win rate ${pct(row.winRatePct).padStart(5)}   ` +
          `avg ${signedPct(row.avgPct).padStart(7)}   hard-stop rate ${pct(row.hardStopRatePct).padStart(5)}${flag}`,
      );
    }
    if (b.skipped > 0) console.log(`  (${b.skipped} trades had no value for this field)`);
  }
  console.log(`\nBuckets with fewer than ${MIN_BUCKET_N} trades are too small to trust -- read those as "not enough data yet," not as a real result.`);
  return 0;
}

/** Synthetic walkthrough of the phase 1 pipeline. Uses its own throwaway database and made-up prices. */
function demo(): number {
  const cfg = parseConfig({ ...(loadConfig() as object), paths: { dbPath: "data/demo.sqlite", stopFile: "STOP-demo-unused" } });
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`data/demo.sqlite${suffix}`, { force: true });
  const ledger = new Ledger(cfg.paths.dbPath);
  const executor = new PaperExecutor(cfg);
  const deps = { cfg, ledger, executor };
  let t = Date.UTC(2026, 8, 19, 12, 0, 0);
  const tick = (mins: number) => (t += mins * 60_000);
  const say = (m: string) => console.log(m);

  say("DEMO: made-up prices, throwaway database (data/demo.sqlite). Nothing here is a real market.\n");
  say(`Wallet ${sol(cfg.wallet.startingSol)}, position size ${pct(cfg.sizing.positionPct)}, daily loss halt ${pct(cfg.risk.dailyLossHaltPct)}\n`);

  // 1. A healthy candidate is opened.
  const a: Quote = { mint: "DEMO_A", symbol: "ALPHA", midPriceSol: 0.00001, liquiditySol: 20 };
  let r = tryOpen(deps, { quote: a, strategy: "snipe" }, t);
  say(`1) Open ALPHA (liquidity ${a.liquiditySol} SOL): ${r.opened ? "OPENED" : "rejected " + r.reasons.join("; ")}`);
  const posA = r.positionId!;

  // 2. Price doubles: recover the initial stake by selling half.
  tick(10);
  const pA = ledger.getPosition(posA)!;
  const up: Quote = { ...a, midPriceSol: a.midPriceSol * 2.1 };
  ledger.updatePeak(posA, up.midPriceSol);
  const half = executor.sell(up, pA.tokens / 2);
  if (half.ok) {
    const o = ledger.recordSell(posA, t, half.fill, "initial recovery at 2x", { markRecoveredInitial: true });
    say(`2) ALPHA hits 2.1x: sold half, realized ${sol(o.realizedDeltaSol)} (stake recovered)`);
  }

  // 3. Price falls 25% from its peak: the rest is sold by the trailing stop.
  tick(15);
  const down: Quote = { ...a, midPriceSol: up.midPriceSol * 0.74 };
  const rest = executor.sell(down, ledger.getPosition(posA)!.tokens, { closing: true });
  if (rest.ok) {
    const o = ledger.recordSell(posA, t, rest.fill, "trailing stop", {});
    say(`3) ALPHA falls 26% from peak: closed, position realized ${sol(ledger.getPosition(posA)!.realized_pnl_sol)} (last leg ${sol(o.realizedDeltaSol)})`);
  }

  // 4. A thin pool fails the cost cap.
  tick(5);
  const b: Quote = { mint: "DEMO_B", symbol: "BRAVO", midPriceSol: 0.00002, liquiditySol: 1.5 };
  r = tryOpen(deps, { quote: b, strategy: "momentum" }, t);
  say(`4) Open BRAVO (liquidity ${b.liquiditySol} SOL): ${r.opened ? "OPENED" : "rejected -> " + r.reasons.join("; ")}`);

  // 5. Another candidate that goes bad and hits the hard stop.
  tick(5);
  const c: Quote = { mint: "DEMO_C", symbol: "CHARLIE", midPriceSol: 0.00003, liquiditySol: 25 };
  r = tryOpen(deps, { quote: c, strategy: "momentum" }, t);
  say(`5) Open CHARLIE (liquidity ${c.liquiditySol} SOL): ${r.opened ? "OPENED" : "rejected " + r.reasons.join("; ")}`);
  if (r.opened) {
    tick(20);
    const crash: Quote = { ...c, midPriceSol: c.midPriceSol * (1 - cfg.risk.hardStopLossPct) };
    const s = executor.sell(crash, ledger.getPosition(r.positionId!)!.tokens, { closing: true });
    if (s.ok) {
      ledger.recordSell(r.positionId!, t, s.fill, "hard stop-loss", {});
      say(`   CHARLIE drops ${pct(cfg.risk.hardStopLossPct)}: closed at the hard stop, realized ${sol(ledger.getPosition(r.positionId!)!.realized_pnl_sol)}`);
    }
  }

  printReport(ledger, cfg, "Demo report");
  say("\nDecision log (every accept and rejection is kept):");
  const rows = ledger.db.prepare("SELECT action, mint, reason FROM decisions ORDER BY id").all() as {
    action: string;
    mint: string;
    reason: string;
  }[];
  for (const d of rows) say(`  ${d.action.padEnd(7)} ${d.mint.padEnd(8)} ${d.reason}`);
  ledger.close();
  return 0;
}

async function scanCommand(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const i = args.indexOf("--minutes");
  const minutes = i >= 0 ? Number(args[i + 1]) : 10;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error("Usage: npm run scan -- --minutes 15 [--debug]");
    return 1;
  }
  return runScan(cfg, { minutes, debug: args.includes("--debug") });
}

async function paperCommand(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const i = args.indexOf("--minutes");
  const minutes = i >= 0 ? Number(args[i + 1]) : Infinity;
  if (!(minutes > 0)) {
    console.error("Usage: npm run paper [-- --minutes 60] [--debug]   (no --minutes runs until Ctrl+C)");
    return 1;
  }
  const ledger = openLedger(cfg);
  try {
    return await runPaper(cfg, { minutes, debug: args.includes("--debug") }, ledger);
  } finally {
    ledger.close();
  }
}

/** Send one test message, to check DISCORD_WEBHOOK_URL. The address itself is never printed. */
async function discordTest(): Promise<number> {
  if (!(process.env.DISCORD_WEBHOOK_URL ?? "").trim()) {
    console.log("DISCORD_WEBHOOK_URL is empty in .env, so there is nowhere to send alerts.");
    return 1;
  }
  const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL, { log: (m) => console.log(m), minIntervalMs: 0 });
  if (!notifier.enabled) return 1; // the notifier has already said why
  notifier.send("✅ Test message from your paper trading bot. Discord alerts are working.");
  await notifier.flush(20_000);
  if (notifier.sent === 1) {
    console.log("Sent. Check your Discord channel for the test message.");
    return 0;
  }
  console.log("The test message was not delivered.");
  return 1;
}

/** Print the daily report for a UTC day (yesterday by default) and send it to Discord unless --print is given. */
async function dailyReport(args: string[]): Promise<number> {
  const cfg = loadConfig();
  const i = args.indexOf("--day");
  const day = i >= 0 ? args[i + 1] : utcDay(Date.now() - 86_400_000);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    console.error("Usage: npm run daily-report [-- --day 2026-10-25] [--print]");
    return 1;
  }
  const ledger = openLedger(cfg);
  const text = buildDailyReport(ledger, cfg, day, ledger.equitySol(cfg.wallet.startingSol));
  ledger.close();
  console.log(text);
  if (args.includes("--print")) return 0;
  const notifier = new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL, { log: (m) => console.log(m), minIntervalMs: 0 });
  if (!notifier.enabled) {
    console.log("\n(Not sent to Discord: DISCORD_WEBHOOK_URL is empty or not a Discord webhook.)");
    return 0;
  }
  notifier.send(text);
  await notifier.flush(20_000);
  console.log(notifier.sent === 1 ? "\nSent to Discord." : "\nNot delivered to Discord.");
  return notifier.sent === 1 ? 0 : 1;
}

const commands: Record<string, (args: string[]) => number | Promise<number>> = {
  "check-env": checkEnv,
  demo,
  status,
  report,
  analyze,
  resume,
  scan: scanCommand,
  paper: paperCommand,
  "discord-test": discordTest,
  "daily-report": dailyReport,
};
const cmd = process.argv[2] ?? "";
const fn = commands[cmd];
if (!fn) {
  console.log("Usage: npm run <check-env | demo | status | report | analyze | resume | scan | paper | discord-test | daily-report>");
  process.exit(cmd ? 1 : 0);
}
try {
  process.exit(await fn(process.argv.slice(3)));
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
