import type { Config } from "../config";
import type { Snapshot } from "../scanner/tracker";

export interface Check {
  rule: string;
  passed: boolean;
  /** What we measured, formatted for people. */
  value: string;
  /** The limit it was compared with. */
  limit: string;
}

export interface GateResult {
  pass: boolean;
  checks: Check[];
  failed: string[];
}

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/**
 * Stage 1 of the safety gate: rules that need only what the launch stream shows. Every rule is evaluated
 * (not just the first failure) so the decision log shows the full picture. All limits come from config.
 */
export function evaluateStreamGate(s: Snapshot, cfg: Config): GateResult {
  const g = cfg.safety;
  const checks: Check[] = [];
  const add = (rule: string, passed: boolean, value: string, limit: string) =>
    checks.push({ rule, passed, value, limit });

  if (g.requireSolQuote) add("QUOTE_SOL", s.quoteIsSol, s.quoteIsSol ? "SOL" : "not SOL", "SOL only");
  if (g.rejectMayhemMode) add("MAYHEM_MODE", !s.mayhem, s.mayhem ? "on" : "off", "off");
  add("TOP10_HOLDERS", s.top10Pct <= g.top10HolderCapPct, pct(s.top10Pct), `<= ${pct(g.top10HolderCapPct)}`);
  add("CREATOR_HOLD", s.creatorPct <= g.maxCreatorHoldPct, pct(s.creatorPct), `<= ${pct(g.maxCreatorHoldPct)}`);
  add(
    "CREATOR_SOLD",
    s.creatorSoldPct <= g.maxCreatorSoldPct,
    pct(s.creatorSoldPct),
    `<= ${pct(g.maxCreatorSoldPct)}`,
  );
  add("BUNDLED", s.bundledPct <= g.maxBundledPct, pct(s.bundledPct), `<= ${pct(g.maxBundledPct)}`);
  add("UNIQUE_BUYERS", s.uniqueBuyers >= g.minUniqueBuyers, String(s.uniqueBuyers), `>= ${g.minUniqueBuyers}`);
  const ratio = s.sellCount === 0 ? Infinity : s.buyCount / s.sellCount;
  add(
    "BUY_SELL_RATIO",
    ratio >= g.minBuySellRatio,
    ratio === Infinity ? "no sells" : ratio.toFixed(2),
    `>= ${g.minBuySellRatio}`,
  );
  add("CURVE_SOL", s.realSol >= g.minRealSol, `${s.realSol.toFixed(2)} SOL`, `>= ${g.minRealSol} SOL`);
  add(
    "CURVE_SOL_MAX",
    s.realSol <= g.maxRealSol,
    `${s.realSol.toFixed(2)} SOL`,
    `<= ${g.maxRealSol} SOL (excludes coins near the graduation cap)`,
  );

  const failed = checks.filter((c) => !c.passed).map((c) => c.rule);
  return { pass: failed.length === 0, checks, failed };
}

export const isToken2022 = (tokenProgram: string): boolean => tokenProgram === TOKEN_2022;

import type { CreateEvent } from "../scanner/events";

/**
 * Rules that can be decided from the create event alone, before any trade data exists. A launch that fails one
 * is never tracked, so it costs no streaming data at all. Returns the rule code, or null if the launch may proceed.
 */
export function launchTimeRule(c: CreateEvent, cfg: Config): "QUOTE_SOL" | "MAYHEM_MODE" | null {
  if (cfg.safety.requireSolQuote && !c.quoteIsSol) return "QUOTE_SOL";
  if (cfg.safety.rejectMayhemMode && c.mayhem) return "MAYHEM_MODE";
  return null;
}
