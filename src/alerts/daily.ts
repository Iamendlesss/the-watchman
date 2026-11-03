import type { Config } from "../config";
import type { Ledger, PositionRow } from "../ledger";
import { clean } from "./discord";
import { sol, signedPct } from "./messages";

const DAY = 86_400_000;
const LAUNCH_TIME = new Set(["QUOTE_SOL", "MAYHEM_MODE", "EARLY_NO_TRACTION"]);
const num = (n: number) => n.toLocaleString("en-US");
const pct0 = (n: number) => `${(n * 100).toFixed(0)}%`;

/** Win rate, average win and loss, and expectancy, all as a share of each trade's cost. */
export function pctStats(positions: PositionRow[]) {
  const r = positions.map((p) => p.realized_pnl_sol / p.cost_basis_sol);
  const wins = r.filter((x) => x >= 0);
  const losses = r.filter((x) => x < 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return { trades: r.length, wins: wins.length, losses: losses.length, avgWin: avg(wins), avgLoss: avg(losses), expectancy: avg(r) };
}

/**
 * The daily report for one UTC day (YYYY-MM-DD): trades closed that day in percent of cost, exits by reason,
 * what the gate saw and rejected, and the last 50 trades for a rolling view. Kept under Discord's 2000
 * characters.
 */
export function buildDailyReport(ledger: Ledger, cfg: Config, day: string, equityNow: number): string {
  const from = Date.parse(`${day}T00:00:00Z`);
  const to = from + DAY;
  const title = `📊 **Daily report for ${day} (UTC)**`;
  const trades = ledger.closedBetween(from, to);
  const counts = ledger.decisionCounts(from, to);
  const minutes = ledger.activeMinutes(from, to);
  if (!trades.length && !counts.length) return `${title}\nThe bot was not running that day, so there is nothing to report.`;

  const lines = [title];
  lines.push(
    `Ran about ${(minutes / 60).toFixed(1)}h. Equity now ${sol(equityNow)} (${signedPct(equityNow / cfg.wallet.startingSol - 1)} since the ${cfg.wallet.startingSol} SOL start).`,
  );
  const peak = ledger.getPeakEquity();
  if (peak) {
    lines.push(
      `Drawdown floor ${sol(peak.peakSol * (1 - cfg.risk.maxDrawdownPct))}, high-water mark ${sol(peak.peakSol)}` +
        (ledger.getHalt() ? ". **Trading is halted.**" : ""),
    );
  }

  if (trades.length) {
    const s = pctStats(trades);
    const pnl = trades.reduce((a, p) => a + p.realized_pnl_sol, 0);
    const fees = trades.reduce((a, p) => a + p.fees_paid_sol, 0);
    const cost = trades.reduce((a, p) => a + p.cost_basis_sol, 0);
    lines.push(`**Trades closed: ${s.trades}**, win rate ${pct0(s.wins / s.trades)} (${s.wins}W/${s.losses}L)`);
    lines.push(
      `Avg win ${signedPct(s.avgWin)}, avg loss ${signedPct(s.avgLoss)}, **expectancy ${signedPct(s.expectancy)} per trade** (share of cost)`,
    );
    lines.push(`P&L ${pnl >= 0 ? "+" : ""}${sol(pnl)}, fees ${sol(fees)} (${(cost > 0 ? (fees / cost) * 100 : 0).toFixed(1)}% of cost)`);
    const byPct = [...trades].sort((a, b) => a.realized_pnl_sol / a.cost_basis_sol - b.realized_pnl_sol / b.cost_basis_sol);
    const show = (p: PositionRow) => `${clean(p.symbol)} ${signedPct(p.realized_pnl_sol / p.cost_basis_sol)} (${p.exit_reason ?? "closed"})`;
    lines.push(trades.length > 1 ? `Best ${show(byPct[byPct.length - 1]!)}, worst ${show(byPct[0]!)}` : `Only trade: ${show(byPct[0]!)}`);
    const exits = new Map<string, number[]>();
    for (const p of trades) {
      const k = p.exit_reason ?? "closed";
      exits.set(k, [...(exits.get(k) ?? []), p.realized_pnl_sol / p.cost_basis_sol]);
    }
    lines.push(
      `Exits: ${[...exits.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, xs]) => `${k} ${xs.length} (avg ${signedPct(xs.reduce((a, b) => a + b, 0) / xs.length)})`)
        .join(", ")}`,
    );
  } else {
    lines.push("**Trades closed: 0**");
  }

  let launches = 0;
  let judged = 0;
  let passed = 0;
  const rules = new Map<string, number>();
  const risk = new Map<string, number>();
  for (const c of counts) {
    if (c.action === "scan_pass") {
      launches += c.count;
      judged += c.count;
      passed += c.count;
    } else if (c.action === "scan_reject") {
      launches += c.count;
      if (LAUNCH_TIME.has(c.reason)) continue;
      judged += c.count;
      for (const r of c.reason.split(",").filter(Boolean)) rules.set(r, (rules.get(r) ?? 0) + c.count);
    } else if (c.action === "reject") {
      for (const r of c.reason.split(",").filter(Boolean)) risk.set(r, (risk.get(r) ?? 0) + c.count);
    }
  }
  lines.push(
    `**Gate:** ${num(launches)} launches, ${num(judged)} judged at ${cfg.scanner.observationSeconds}s, ${passed} passed` +
      (launches ? ` (${((passed / launches) * 100).toFixed(2)}% of launches)` : ""),
  );
  const top = [...rules.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (top.length) lines.push(`Top rejections: ${top.map(([r, n]) => `${r} ${num(n)}`).join(", ")}`);
  if (risk.size) lines.push(`Entries blocked by risk rules: ${[...risk.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ")}`);

  const recent = ledger.recentClosed(50);
  if (recent.length) {
    const s = pctStats(recent);
    lines.push(`Last ${s.trades} trades overall: win rate ${pct0(s.wins / s.trades)}, expectancy ${signedPct(s.expectancy)} per trade`);
  }
  return lines.join("\n");
}
