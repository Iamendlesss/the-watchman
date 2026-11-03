import type { Config } from "../config";
import type { Strategy } from "../ledger";

export interface ExitInputs {
  strategy: Strategy;
  /** Average entry price in SOL per token. */
  entryPrice: number;
  /** Highest mid price seen since entry. */
  peakPrice: number;
  /** Current mid price. */
  price: number;
  recoveredInitial: boolean;
  ageMs: number;
  /** Share of the creator's own purchases that the creator has sold so far (0 to 1). */
  creatorSoldPct: number;
  /** The bonding curve has completed and the coin has moved to a DEX pool. */
  graduated: boolean;
}

export type ExitDecision =
  | { action: "hold" }
  | { action: "sell"; fraction: number; reason: string; markRecovered?: boolean };

/**
 * The exit rules, in priority order. Pure: it looks only at the numbers it is given, so every rule can be tested.
 * 1. graduation (the curve price no longer applies; momentum on the DEX pool is a later phase)
 * 2. creator dump
 * 3. hard stop-loss
 * 4. initial recovery: sell enough at the target multiple to take the stake back out
 * 5. second target: once recovered, sell the remainder in full if it doubles again (entry x recovery x second)
 * 6. trailing stop on the remainder (the backstop if it never reaches the second target)
 * 7. time stop: a coin that has not gained enough by its deadline (only before recovery)
 */
export function decideExit(i: ExitInputs, cfg: Config): ExitDecision {
  const x = cfg.exits;
  if (i.graduated) return { action: "sell", fraction: 1, reason: "graduated" };
  if (i.creatorSoldPct >= x.creatorDumpExitPct) return { action: "sell", fraction: 1, reason: "creator dump" };
  if (i.price <= i.entryPrice * (1 - cfg.risk.hardStopLossPct)) {
    return { action: "sell", fraction: 1, reason: "hard stop-loss" };
  }
  if (!i.recoveredInitial && i.price >= i.entryPrice * x.initialRecoveryMultiple) {
    return {
      action: "sell",
      fraction: 1 / x.initialRecoveryMultiple,
      reason: `initial recovery at ${x.initialRecoveryMultiple}x`,
      markRecovered: true,
    };
  }
  if (i.recoveredInitial) {
    const secondTargetMult = x.initialRecoveryMultiple * x.secondTargetMultiple;
    if (i.price >= i.entryPrice * secondTargetMult) {
      return { action: "sell", fraction: 1, reason: `second target at ${secondTargetMult}x` };
    }
    if (i.price <= i.peakPrice * (1 - x.trailingStopPct)) {
      return { action: "sell", fraction: 1, reason: "trailing stop" };
    }
  }
  const deadlineMs = x.timeStopMinutes[i.strategy] * 60_000;
  if (!i.recoveredInitial && i.ageMs >= deadlineMs && i.price < i.entryPrice * (1 + x.timeStopMinGainPct)) {
    return { action: "sell", fraction: 1, reason: "time stop" };
  }
  return { action: "hold" };
}
