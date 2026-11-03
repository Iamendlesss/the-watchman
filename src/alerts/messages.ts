import type { Config } from "../config";
import type { PositionRow } from "../ledger";
import type { Snapshot } from "../scanner/tracker";
import { clean } from "./discord";

export const sol = (n: number) => `${n >= 0 ? "" : "-"}${Math.abs(n).toFixed(4)} SOL`;
export const signedPct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const num = (n: number) => n.toLocaleString("en-US");
export const duration = (ms: number) =>
  ms < 3_600_000 ? `${Math.max(0, Math.round(ms / 60_000))}m` : `${(ms / 3_600_000).toFixed(1)}h`;
/** Like `duration`, but in seconds under two minutes. */
const short = (ms: number) => (ms < 120_000 ? `${Math.round(ms / 1000)}s` : duration(ms));
/** Mints come from decoded chain data, but are still checked before they go into a link. */
const link = (mint: string) => (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? ` <https://pump.fun/coin/${mint}>` : "");
const equityLine = (equity: number, startingSol: number) =>
  `Equity ${sol(equity)} (${signedPct(equity / startingSol - 1)} since the ${startingSol} SOL start).`;

export function started(cfg: Config, equity: number, orphansClosed: number, peak: number, halt: string | null): string {
  const s = cfg.safety;
  return (
    `🟢 **Paper bot started.** ${equityLine(equity, cfg.wallet.startingSol)}\n` +
    `Entry filter: curve ${s.minRealSol}-${s.maxRealSol} SOL, top-10 holders ≤ ${pct(s.top10HolderCapPct)}, ≥ ${s.minUniqueBuyers} buyers. ` +
    `${pct(cfg.sizing.positionPct)} per trade, max ${cfg.sizing.maxOpenPositions} open.\n` +
    `Drawdown floor ${sol(peak * (1 - cfg.risk.maxDrawdownPct))} (${pct(cfg.risk.maxDrawdownPct)} below the high-water mark of ${sol(peak)}).` +
    (halt ? `\n🛑 Trading is halted: ${halt}. Run \`npm run resume\` to allow new trades.` : "") +
    (orphansClosed
      ? `\nClosed ${orphansClosed} position(s) left open by the last run, at their last price minus ${pct(cfg.paper.restartHaircutPct)}.`
      : "")
  );
}

export function stopped(p: { ranMs: number; opened: number; closed: number; equity: number; startingSol: number }): string {
  return (
    `🔴 **Paper bot stopped** after ${duration(p.ranMs)}. This run: ${p.opened} trade(s) opened, ${p.closed} closed. ` +
    `${equityLine(p.equity, p.startingSol)} No alerts until it is started again.`
  );
}

export function opened(pos: PositionRow, snap: Snapshot): string {
  return (
    `📈 **BUY** ${clean(pos.symbol)} ${sol(pos.entry_size_sol)}. Curve ${snap.realSol.toFixed(1)} SOL, ${snap.uniqueBuyers} buyers, ` +
    `top-10 ${pct(snap.top10Pct)}, bundled ${pct(snap.bundledPct)}, run-up ${snap.runupMultiple.toFixed(1)}x.${link(pos.mint)}`
  );
}

export function partial(pos: PositionRow, reason: string, realizedSol: number): string {
  return `💰 **PARTIAL SELL** ${clean(pos.symbol)}: ${reason}, ${realizedSol >= 0 ? "+" : ""}${sol(realizedSol)} realized.`;
}

/** `pos` is the position after it closed. */
export function closed(pos: PositionRow): string {
  const r = pos.realized_pnl_sol / pos.cost_basis_sol;
  const held = (pos.closed_at ?? pos.opened_at) - pos.opened_at;
  return (
    `${r >= 0 ? "✅" : "❌"} **SOLD** ${clean(pos.symbol)} ${signedPct(r)} of cost (${pos.realized_pnl_sol >= 0 ? "+" : ""}${sol(pos.realized_pnl_sol)}). ` +
    `${pos.exit_reason ?? "closed"}, held ${duration(held)}.`
  );
}

export function floorHit(equity: number, peak: number, cfg: Config): string {
  return (
    `🛑 **Drawdown floor hit**: equity ${sol(equity)} is ${((1 - equity / peak) * 100).toFixed(1)}% below the high-water mark of ` +
    `${sol(peak)} (limit ${pct(cfg.risk.maxDrawdownPct)}). No new trades until you run \`npm run resume\`. ` +
    "Open positions keep their normal exits."
  );
}

/** A risk rule blocked an entry. `message` is the risk manager's own explanation. */
export function riskBlocked(code: string, message: string): string {
  if (code === "HALTED" || code === "DAILY_LOSS" || code === "DRAWDOWN") return `🛑 **Trading halted**: ${message}. Run \`npm run resume\` to allow new trades again.`;
  if (code === "STOP_FILE") return "⏸️ **New trades blocked**: the STOP file is present. Delete it to allow new trades again.";
  return `⏸️ **New trades paused** (${code}): ${message}.`;
}

export function streamDown(ms: number, openPositions: number): string {
  return (
    `📡 **Stream down** for ${short(ms)} (no connection open). ` +
    (openPositions ? `${openPositions} open position(s) are not being watched for exits.` : "No positions are open.")
  );
}

export function streamBack(ms: number): string {
  return `📡 Stream back after ${short(ms)}.`;
}

export function heartbeat(p: {
  upMs: number;
  sinceMs: number;
  launches: number;
  judged: number;
  passed: number;
  opened: number;
  closed: number;
  equity: number;
  startingSol: number;
}): string {
  return (
    `💓 Still running (up ${duration(p.upMs)}). Last ${duration(p.sinceMs)}: ${num(p.launches)} launches, ${num(p.judged)} judged, ` +
    `${p.passed} passed, ${p.opened} trade(s) opened, ${p.closed} closed. ${equityLine(p.equity, p.startingSol)}`
  );
}
