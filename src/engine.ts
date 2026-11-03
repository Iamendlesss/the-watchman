import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import type { Executor, Quote } from "./executor";
import type { Ledger, Strategy } from "./ledger";
import { DRAWDOWN_HALT, evaluateOpen, positionSizeSol, type RiskInputs } from "./risk";

export interface Deps {
  cfg: Config;
  ledger: Ledger;
  executor: Executor;
  /** Injected so tests do not depend on the real file system. */
  stopFilePresent?: () => boolean;
}

export interface Candidate {
  quote: Quote;
  strategy: Strategy;
  gateSnapshot?: unknown;
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function stopFileExists(cfg: Config): boolean {
  return fs.existsSync(path.resolve(cfg.paths.stopFile));
}

export function buildRiskInputs(deps: Deps, nowMs: number, marks: Map<string, number>): RiskInputs {
  const { cfg, ledger } = deps;
  const equity = ledger.equitySol(cfg.wallet.startingSol, marks);
  const streak = ledger.consecutiveLosses();
  const peak = ledger.peakEquity(equity, nowMs);
  if (equity > peak) ledger.raisePeakEquity(equity, nowMs);
  return {
    nowMs,
    equitySol: equity,
    startOfDayEquitySol: ledger.startOfDayEquity(utcDay(nowMs), equity, nowMs),
    peakEquitySol: Math.max(peak, equity),
    cashSol: ledger.cashSol(cfg.wallet.startingSol),
    openPositions: ledger.getOpenPositions().length,
    consecutiveLosses: streak.count,
    lastLossAtMs: streak.lastLossAt,
    stopFilePresent: (deps.stopFilePresent ?? (() => stopFileExists(cfg)))(),
    halted: ledger.getHalt(),
  };
}

/**
 * `npm run resume`: clear the halt. When it was the drawdown floor, the high-water mark restarts from today's
 * equity (open positions at entry price), or the floor would halt again straight away.
 */
export function resumeTrading(ledger: Ledger, cfg: Config, nowMs: number): { cleared: string | null; newPeakSol?: number } {
  const halt = ledger.getHalt();
  if (!halt) return { cleared: null };
  ledger.clearHalt(nowMs);
  if (!halt.reason.startsWith(DRAWDOWN_HALT)) return { cleared: halt.reason };
  const equity = ledger.equitySol(cfg.wallet.startingSol);
  ledger.resetPeakEquity(equity, nowMs);
  return { cleared: halt.reason, newPeakSol: equity };
}

export interface OpenOutcome {
  opened: boolean;
  positionId?: number;
  reasons: string[];
}

/**
 * The only path to a new position: risk rules first, then the executor, and every outcome is logged,
 * including rejections, so the paper week leaves a full decision trail.
 */
export function tryOpen(deps: Deps, cand: Candidate, nowMs: number, marks: Map<string, number> = new Map()): OpenOutcome {
  const { cfg, ledger, executor } = deps;
  const { quote, strategy } = cand;
  const inputs = buildRiskInputs(deps, nowMs, marks);
  const size = positionSizeSol(inputs.equitySol, cfg);
  const decision = evaluateOpen(
    inputs,
    {
      sizeSol: size,
      estRoundTripCostSol: executor.estimateRoundTripCostSol(size, quote.liquiditySol, quote.tradeFeePct ?? 0),
      buyOverheadSol: executor.buyOverheadSol(),
    },
    cfg,
  );

  if (decision.newHalt) ledger.setHalt(decision.newHalt, nowMs);

  if (!decision.allowed) {
    const reasons = decision.blocks.map((b) => `${b.code}: ${b.message}`);
    ledger.logDecision({
      ts: nowMs,
      mint: quote.mint,
      strategy,
      action: "reject",
      reason: decision.blocks.map((b) => b.code).join(","),
      details: { messages: reasons, sizeSol: size },
    });
    return { opened: false, reasons };
  }

  const res = executor.buy(quote, size);
  if (!res.ok) {
    ledger.logDecision({
      ts: nowMs,
      mint: quote.mint,
      strategy,
      action: "reject",
      reason: "EXEC_FAILED",
      details: { message: res.reason },
    });
    return { opened: false, reasons: [`EXEC_FAILED: ${res.reason}`] };
  }

  const id = ledger.openPosition({
    mint: quote.mint,
    symbol: quote.symbol,
    strategy,
    ts: nowMs,
    fill: res.fill,
    gateSnapshot: cand.gateSnapshot,
  });
  ledger.logDecision({
    ts: nowMs,
    mint: quote.mint,
    strategy,
    action: "open",
    reason: "passed risk checks",
    details: { positionId: id, sizeSol: size, slippagePct: res.fill.slippagePct },
  });
  return { opened: true, positionId: id, reasons: [] };
}
