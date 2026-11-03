import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import {
  dailyLossBreached,
  drawdownBreached,
  drawdownFloorSol,
  evaluateOpen,
  positionSizeSol,
  type Proposal,
  type RiskInputs,
} from "../src/risk";

const cfg = parseConfig({});
const NOW = Date.UTC(2026, 8, 19, 12);
const base: RiskInputs = {
  nowMs: NOW, equitySol: 3, startOfDayEquitySol: 3, peakEquitySol: 3, cashSol: 3, openPositions: 0,
  consecutiveLosses: 0, lastLossAtMs: null, stopFilePresent: false, halted: null,
};
const prop: Proposal = { sizeSol: 0.09, estRoundTripCostSol: 0.003, buyOverheadSol: 0.0026 };
const codes = (i: Partial<RiskInputs>, p: Partial<Proposal> = {}) =>
  evaluateOpen({ ...base, ...i }, { ...prop, ...p }, cfg).blocks.map((b) => b.code);

describe("risk manager", () => {
  it("sizes positions at 3% of equity", () => {
    expect(positionSizeSol(3, cfg)).toBeCloseTo(0.09, 12);
  });

  it("allows a clean proposal", () => {
    expect(evaluateOpen(base, prop, cfg).allowed).toBe(true);
  });

  it("blocks on the STOP file", () => {
    expect(codes({ stopFilePresent: true })).toContain("STOP_FILE");
  });

  it("blocks and reports a new halt when the daily loss limit is hit", () => {
    // Exactly 35% down for the day. The high-water mark was reset today, so the 30% drawdown floor isn't involved.
    const d = evaluateOpen({ ...base, equitySol: 1.95, peakEquitySol: 1.95 }, prop, cfg);
    expect(d.allowed).toBe(false);
    expect(d.newHalt).toMatch(/35%/);
    expect(dailyLossBreached(1.96, 3, cfg)).toBe(false);
    expect(dailyLossBreached(1.95, 3, cfg)).toBe(true);
  });

  it("halts new trades once equity is 30% below its high-water mark", () => {
    const d = evaluateOpen({ ...base, equitySol: 2.1, peakEquitySol: 3, startOfDayEquitySol: 2.2 }, prop, cfg); // exactly 30%
    expect(d.allowed).toBe(false);
    expect(d.blocks.map((b) => b.code)).toEqual(["DRAWDOWN"]);
    expect(d.newHalt).toBe("drawdown floor: equity 2.1000 SOL is 30.0% below the high-water mark of 3.0000 SOL (limit 30%)");
    expect(codes({ equitySol: 2.11, peakEquitySol: 3, startOfDayEquitySol: 2.2 })).toEqual([]); // just above the floor
    expect(drawdownFloorSol(3, cfg)).toBeCloseTo(2.1, 12);
    expect(drawdownBreached(2.1, 3, cfg)).toBe(true);
  });

  it("reports both limits when a day's loss also breaks the floor, and halts for the floor", () => {
    const d = evaluateOpen({ ...base, equitySol: 1.9, peakEquitySol: 3, startOfDayEquitySol: 3 }, prop, cfg);
    expect(d.blocks.map((b) => b.code)).toEqual(["DRAWDOWN", "DAILY_LOSS"]);
    expect(d.newHalt).toMatch(/^drawdown floor/);
  });

  it("an existing halt blocks even if equity has recovered", () => {
    const d = evaluateOpen({ ...base, halted: { reason: "daily loss" } }, prop, cfg);
    expect(d.blocks.map((b) => b.code)).toContain("HALTED");
    expect(d.newHalt).toBeUndefined();
  });

  it("caps open positions", () => {
    expect(codes({ openPositions: 4 })).toContain("MAX_POSITIONS");
    expect(codes({ openPositions: 3 })).not.toContain("MAX_POSITIONS");
  });

  it("pauses after 4 straight losses for 60 minutes, then releases", () => {
    const lastLossAtMs = NOW - 30 * 60_000;
    expect(codes({ consecutiveLosses: 4, lastLossAtMs })).toContain("LOSS_PAUSE");
    expect(codes({ consecutiveLosses: 3, lastLossAtMs })).not.toContain("LOSS_PAUSE");
    expect(codes({ consecutiveLosses: 4, lastLossAtMs: NOW - 61 * 60_000 })).not.toContain("LOSS_PAUSE");
  });

  it("keeps the minimum SOL reserve", () => {
    expect(codes({ cashSol: 0.14 })).toContain("INSUFFICIENT_CASH"); // 0.14 - 0.0926 < 0.05
    expect(codes({ cashSol: 0.2 })).not.toContain("INSUFFICIENT_CASH");
  });

  it("blocks when the round-trip cost is over 6% of the position", () => {
    expect(codes({}, { estRoundTripCostSol: 0.09 * 0.061 })).toContain("COST_CAP");
    expect(codes({}, { estRoundTripCostSol: 0.09 * 0.059 })).not.toContain("COST_CAP");
  });

  it("reports every failing rule, not just the first", () => {
    const c = codes({ stopFilePresent: true, openPositions: 4 }, { estRoundTripCostSol: 0.05 });
    expect(c).toEqual(expect.arrayContaining(["STOP_FILE", "MAX_POSITIONS", "COST_CAP"]));
  });
});
