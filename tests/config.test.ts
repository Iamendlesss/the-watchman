import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";

describe("config", () => {
  it("fills in the approved defaults", () => {
    const c = parseConfig({});
    expect(c.mode).toBe("paper");
    expect(c.sizing.positionPct).toBe(0.03);
    expect(c.sizing.maxOpenPositions).toBe(4);
    expect(c.risk.dailyLossHaltPct).toBe(0.35);
    expect(c.risk.hardStopLossPct).toBe(0.25);
    expect(c.risk.maxRoundTripCostPct).toBe(0.06);
    expect(c.risk.consecutiveLossPause).toEqual({ losses: 4, cooldownMinutes: 60 });
    expect(c.exits.trailingStopPct).toBe(0.25);
    expect(c.exits.timeStopMinutes).toEqual({ snipe: 30, momentum: 120 });
    expect(c.wallet.minSolReserve).toBe(0.05);
  });

  it("refuses live mode in this build", () => {
    expect(() => parseConfig({ mode: "live" })).toThrow(/not available/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseConfig({ sizing: { positionPct: 1.5 } })).toThrow();
    expect(() => parseConfig({ risk: { dailyLossHaltPct: 0 } })).toThrow();
    expect(() => parseConfig({ sizing: { maxOpenPositions: 0 } })).toThrow();
  });

  it("requires the SOL reserve to be smaller than the starting balance", () => {
    expect(() => parseConfig({ wallet: { startingSol: 0.04, minSolReserve: 0.05 } })).toThrow();
  });

  it("keeps partial overrides and defaults the rest", () => {
    const c = parseConfig({ sizing: { positionPct: 0.05 } });
    expect(c.sizing.positionPct).toBe(0.05);
    expect(c.sizing.maxOpenPositions).toBe(4);
  });
});
