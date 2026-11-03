import type { Config } from "./config";

export type BlockCode =
  | "STOP_FILE"
  | "HALTED"
  | "DAILY_LOSS"
  | "DRAWDOWN"
  | "MAX_POSITIONS"
  | "LOSS_PAUSE"
  | "INSUFFICIENT_CASH"
  | "COST_CAP";

export interface RiskInputs {
  nowMs: number;
  equitySol: number;
  startOfDayEquitySol: number;
  /** Highest equity since the drawdown floor was last reset (the high-water mark). */
  peakEquitySol: number;
  cashSol: number;
  openPositions: number;
  consecutiveLosses: number;
  lastLossAtMs: number | null;
  stopFilePresent: boolean;
  /** An unresolved halt from an earlier day or run. Stays in force until you run `npm run resume`. */
  halted: { reason: string } | null;
}

export interface Proposal {
  sizeSol: number;
  /** Fees, price impact and slippage for the round trip, in SOL. */
  estRoundTripCostSol: number;
  /** Leg fees plus token-account rent that the buy needs on top of the swap amount. */
  buyOverheadSol: number;
}

export interface RiskDecision {
  allowed: boolean;
  blocks: { code: BlockCode; message: string }[];
  /** Set when this check just found the drawdown floor or daily loss limit breached; the caller must persist a halt. */
  newHalt?: string;
}

export function positionSizeSol(equitySol: number, cfg: Config): number {
  return equitySol * cfg.sizing.positionPct;
}

export function dailyLossBreached(equitySol: number, startOfDayEquitySol: number, cfg: Config): boolean {
  return equitySol <= startOfDayEquitySol * (1 - cfg.risk.dailyLossHaltPct);
}

/** Every drawdown halt's reason starts with this, so `resume` knows to reset the high-water mark. */
export const DRAWDOWN_HALT = "drawdown floor";

export function drawdownFloorSol(peakEquitySol: number, cfg: Config): number {
  return peakEquitySol * (1 - cfg.risk.maxDrawdownPct);
}

export function drawdownBreached(equitySol: number, peakEquitySol: number, cfg: Config): boolean {
  return equitySol <= drawdownFloorSol(peakEquitySol, cfg) + 1e-9; // so exactly on the floor counts (3 * 0.7 is 2.0999...)
}

export function drawdownHaltReason(equitySol: number, peakEquitySol: number, cfg: Config): string {
  return (
    `${DRAWDOWN_HALT}: equity ${equitySol.toFixed(4)} SOL is ${((1 - equitySol / peakEquitySol) * 100).toFixed(1)}% below the ` +
    `high-water mark of ${peakEquitySol.toFixed(4)} SOL (limit ${(cfg.risk.maxDrawdownPct * 100).toFixed(0)}%)`
  );
}

/** Every rule that blocks a new position is reported, not just the first. */
export function evaluateOpen(inp: RiskInputs, prop: Proposal, cfg: Config): RiskDecision {
  const blocks: RiskDecision["blocks"] = [];
  let newHalt: string | undefined;

  if (inp.stopFilePresent) {
    blocks.push({ code: "STOP_FILE", message: "STOP file present (kill switch)" });
  }
  if (inp.halted) {
    blocks.push({ code: "HALTED", message: `halted until manual resume: ${inp.halted.reason}` });
  } else {
    if (drawdownBreached(inp.equitySol, inp.peakEquitySol, cfg)) {
      newHalt = drawdownHaltReason(inp.equitySol, inp.peakEquitySol, cfg);
      blocks.push({ code: "DRAWDOWN", message: newHalt });
    }
    if (dailyLossBreached(inp.equitySol, inp.startOfDayEquitySol, cfg)) {
      const msg = `daily loss limit of ${(cfg.risk.dailyLossHaltPct * 100).toFixed(0)}% reached`;
      newHalt ??= msg; // the drawdown floor is the more serious of the two
      blocks.push({ code: "DAILY_LOSS", message: msg });
    }
  }
  if (inp.openPositions >= cfg.sizing.maxOpenPositions) {
    blocks.push({
      code: "MAX_POSITIONS",
      message: `${inp.openPositions} positions open (max ${cfg.sizing.maxOpenPositions})`,
    });
  }
  const pause = cfg.risk.consecutiveLossPause;
  if (inp.consecutiveLosses >= pause.losses && inp.lastLossAtMs !== null) {
    const until = inp.lastLossAtMs + pause.cooldownMinutes * 60_000;
    if (inp.nowMs < until) {
      const mins = Math.ceil((until - inp.nowMs) / 60_000);
      blocks.push({
        code: "LOSS_PAUSE",
        message: `${inp.consecutiveLosses} losses in a row; paused ${mins} more min`,
      });
    }
  }
  const needed = prop.sizeSol + prop.buyOverheadSol;
  if (inp.cashSol - needed < cfg.wallet.minSolReserve) {
    blocks.push({
      code: "INSUFFICIENT_CASH",
      message: `cash ${inp.cashSol.toFixed(4)} SOL would fall below the ${cfg.wallet.minSolReserve} SOL reserve`,
    });
  }
  const costPct = prop.estRoundTripCostSol / prop.sizeSol;
  if (costPct > cfg.risk.maxRoundTripCostPct) {
    blocks.push({
      code: "COST_CAP",
      message: `round-trip cost ${(costPct * 100).toFixed(1)}% exceeds ${(cfg.risk.maxRoundTripCostPct * 100).toFixed(0)}% cap`,
    });
  }

  return { allowed: blocks.length === 0, blocks, newHalt };
}
