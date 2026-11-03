import { describe, expect, it } from "vitest";
import { Ledger, type Fill } from "../src/ledger";

const buy = (over: Partial<Fill> = {}): Fill => ({
  side: "buy", tokens: 1000, priceSol: 0.0001, solAmount: 0.1, feesSol: 0.001, rentSol: 0.002, slippagePct: 0.01, ...over,
});
const sell = (over: Partial<Fill> = {}): Fill => ({
  side: "sell", tokens: 500, priceSol: 0.0002, solAmount: 0.1, feesSol: 0.001, rentSol: 0, slippagePct: 0.01, ...over,
});
const T0 = Date.UTC(2026, 8, 19, 12);

describe("ledger", () => {
  it("tracks cash including rent deposits", () => {
    const l = new Ledger(":memory:");
    l.openPosition({ mint: "A", symbol: "A", strategy: "snipe", ts: T0, fill: buy() });
    expect(l.cashSol(3)).toBeCloseTo(3 - 0.1 - 0.001 - 0.002, 10);
    // equity holds the rent deposit and values tokens at entry price by default
    expect(l.equitySol(3)).toBeCloseTo(3 - 0.001 + 0, 9);
  });

  it("realizes P&L on partial then final sells using proportional cost basis", () => {
    const l = new Ledger(":memory:");
    const id = l.openPosition({ mint: "A", symbol: "A", strategy: "snipe", ts: T0, fill: buy() });
    const first = l.recordSell(id, T0 + 1, sell(), "recovery", { markRecoveredInitial: true });
    // basis for half = (0.1 + 0.001) / 2 = 0.0505 ; realized = 0.1 - 0.001 - 0.0505 = 0.0485
    expect(first.realizedDeltaSol).toBeCloseTo(0.0485, 10);
    expect(first.closed).toBe(false);
    const last = l.recordSell(id, T0 + 2, sell({ solAmount: 0.05, rentSol: -0.002 }), "trailing stop");
    // remaining basis 0.0505 ; realized = 0.05 - 0.001 - 0.0505 = -0.0015
    expect(last.realizedDeltaSol).toBeCloseTo(-0.0015, 10);
    expect(last.closed).toBe(true);
    const p = l.getPosition(id)!;
    expect(p.status).toBe("closed");
    expect(p.tokens).toBe(0);
    expect(p.realized_pnl_sol).toBeCloseTo(0.047, 10);
    expect(p.recovered_initial).toBe(1);
    // cash reconciles: start + realized pnl (rent returned)
    expect(l.cashSol(3)).toBeCloseTo(3 + 0.047, 9);
  });

  it("refuses to sell more than is held or to sell a closed position", () => {
    const l = new Ledger(":memory:");
    const id = l.openPosition({ mint: "A", symbol: "A", strategy: "snipe", ts: T0, fill: buy() });
    expect(() => l.recordSell(id, T0, sell({ tokens: 2000 }), "x")).toThrow(/only 1000/);
    l.recordSell(id, T0, sell({ tokens: 1000 }), "close");
    expect(() => l.recordSell(id, T0, sell({ tokens: 1 }), "x")).toThrow(/already closed/);
  });

  it("counts consecutive losses from the most recent trade backwards", () => {
    const l = new Ledger(":memory:");
    const lose = (ts: number) => {
      const id = l.openPosition({ mint: "L" + ts, symbol: "L", strategy: "momentum", ts, fill: buy() });
      l.recordSell(id, ts + 1, sell({ tokens: 1000, solAmount: 0.05 }), "stop");
    };
    const win = (ts: number) => {
      const id = l.openPosition({ mint: "W" + ts, symbol: "W", strategy: "momentum", ts, fill: buy() });
      l.recordSell(id, ts + 1, sell({ tokens: 1000, solAmount: 0.3 }), "tp");
    };
    lose(T0); win(T0 + 10); lose(T0 + 20); lose(T0 + 30);
    const s = l.consecutiveLosses();
    expect(s.count).toBe(2);
    expect(s.lastLossAt).toBe(T0 + 31);
  });

  it("stores start-of-day equity once and returns the first value all day", () => {
    const l = new Ledger(":memory:");
    expect(l.startOfDayEquity("2026-09-19", 3, T0)).toBe(3);
    expect(l.startOfDayEquity("2026-09-19", 2.5, T0 + 1)).toBe(3);
    expect(l.startOfDayEquity("2026-09-20", 2.5, T0 + 1)).toBe(2.5);
  });

  it("keeps the high-water mark: seeded on first use, only ever raised, and reset on request", () => {
    const l = new Ledger(":memory:");
    expect(l.getPeakEquity()).toBeNull();
    expect(l.peakEquity(1.33, T0)).toBe(1.33); // starts from today's equity, not an old peak
    expect(l.peakEquity(2, T0 + 1)).toBe(1.33);
    l.raisePeakEquity(1.5, T0 + 2);
    l.raisePeakEquity(1.4, T0 + 3); // lower: ignored
    expect(l.getPeakEquity()).toEqual({ peakSol: 1.5, setAt: T0 + 2, resetAt: T0 });
    l.resetPeakEquity(1.1, T0 + 4);
    expect(l.getPeakEquity()).toEqual({ peakSol: 1.1, setAt: T0 + 4, resetAt: T0 + 4 });
  });

  it("keeps a halt in force until it is cleared", () => {
    const l = new Ledger(":memory:");
    expect(l.getHalt()).toBeNull();
    l.setHalt("daily loss", T0);
    l.setHalt("second call is ignored", T0 + 1);
    expect(l.getHalt()?.reason).toBe("daily loss");
    expect(l.clearHalt(T0 + 2)).toBe(true);
    expect(l.getHalt()).toBeNull();
    expect(l.clearHalt(T0 + 3)).toBe(false);
  });

  it("summarizes wins, losses and per-strategy results", () => {
    const l = new Ledger(":memory:");
    const a = l.openPosition({ mint: "A", symbol: "A", strategy: "snipe", ts: T0, fill: buy() });
    l.recordSell(a, T0 + 1, sell({ tokens: 1000, solAmount: 0.3 }), "tp");
    const b = l.openPosition({ mint: "B", symbol: "B", strategy: "momentum", ts: T0 + 2, fill: buy() });
    l.recordSell(b, T0 + 3, sell({ tokens: 1000, solAmount: 0.05 }), "stop");
    const s = l.summary();
    expect(s.closedPositions).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.byStrategy.snipe?.wins).toBe(1);
    expect(s.byStrategy.momentum?.realizedPnlSol).toBeLessThan(0);
  });
});

describe("percent-based reporting (size-independent breakdowns)", () => {
  function closedPosition(l: Ledger, mint: string, ts: number, reason: string, sellOver: Partial<Fill> = {}) {
    const id = l.openPosition({ mint, symbol: mint, strategy: "snipe", ts, fill: buy() });
    l.recordSell(id, ts + 1, sell({ tokens: 1000, ...sellOver }), reason);
    return id;
  }

  it("exitBreakdown reports both the SOL total and the average percent return per category", () => {
    const l = new Ledger(":memory:");
    closedPosition(l, "A", T0, "target", { solAmount: 0.3 }); // cost 0.101, realized 0.198 => +196.0%
    closedPosition(l, "B", T0 + 10, "stop", { solAmount: 0.05 }); // cost 0.101, realized -0.052 => -51.5%
    const rows = l.exitBreakdown();
    const target = rows.find((r) => r.reason === "target")!;
    const stop = rows.find((r) => r.reason === "stop")!;
    expect(target.count).toBe(1);
    expect(target.pnlSol).toBeCloseTo(0.198, 9);
    expect(target.avgPct).toBeCloseTo(0.198 / 0.101, 6);
    expect(stop.count).toBe(1);
    expect(stop.pnlSol).toBeCloseTo(-0.052, 9);
    expect(stop.avgPct).toBeCloseTo(-0.052 / 0.101, 6);
  });

  it("averages the percent across multiple trades in the same category, not just the SOL total", () => {
    const l = new Ledger(":memory:");
    closedPosition(l, "A", T0, "stop", { solAmount: 0.05 }); // -51.5%
    closedPosition(l, "B", T0 + 10, "stop", { solAmount: 0.06 }); // (0.06-0.001-0.101)/0.101 = -41.6%
    const row = l.exitBreakdown().find((r) => r.reason === "stop")!;
    expect(row.count).toBe(2);
    const pct1 = (0.05 - 0.001 - 0.101) / 0.101;
    const pct2 = (0.06 - 0.001 - 0.101) / 0.101;
    expect(row.avgPct).toBeCloseTo((pct1 + pct2) / 2, 6);
  });

  it("exitBreakdownSince only includes positions opened at or after the cutoff", () => {
    const l = new Ledger(":memory:");
    closedPosition(l, "OLD", T0, "stop", { solAmount: 0.05 });
    closedPosition(l, "NEW", T0 + 100, "stop", { solAmount: 0.06 });
    const all = l.exitBreakdownSince(T0);
    expect(all.find((r) => r.reason === "stop")?.count).toBe(2);
    const sinceNew = l.exitBreakdownSince(T0 + 100);
    expect(sinceNew.find((r) => r.reason === "stop")?.count).toBe(1);
    expect(sinceNew.find((r) => r.reason === "stop")?.pnlSol).toBeCloseTo(0.06 - 0.001 - 0.101, 9);
  });

  it("pctSummary computes win rate, avg win/loss and expectancy as percents of cost", () => {
    const l = new Ledger(":memory:");
    closedPosition(l, "A", T0, "target", { solAmount: 0.3 }); // win, +196.0%
    closedPosition(l, "B", T0 + 10, "stop", { solAmount: 0.05 }); // loss, -51.5%
    const p = l.pctSummary()!;
    expect(p.trades).toBe(2);
    expect(p.winRatePct).toBeCloseTo(0.5, 9);
    expect(p.avgWinPct).toBeCloseTo(0.198 / 0.101, 6);
    expect(p.avgLossPct).toBeCloseTo(-0.052 / 0.101, 6);
    expect(p.expectancyPct).toBeCloseTo((0.198 / 0.101 + -0.052 / 0.101) / 2, 6);
  });

  it("pctSummary respects the since cutoff and returns null when nothing is closed yet", () => {
    const l = new Ledger(":memory:");
    expect(l.pctSummary()).toBeNull();
    closedPosition(l, "A", T0, "stop", { solAmount: 0.05 });
    closedPosition(l, "B", T0 + 100, "target", { solAmount: 0.3 });
    expect(l.pctSummary(T0 + 100)?.trades).toBe(1);
    expect(l.pctSummary(T0 + 100)?.winRatePct).toBeCloseTo(1, 9);
    expect(l.pctSummary(T0 + 1000)).toBeNull(); // cutoff after every trade
  });

  it("counts a breakeven-or-better trade as a win, consistent with the rest of the ledger", () => {
    const l = new Ledger(":memory:");
    // realized = solAmount - feesSol - costBasis; a hair above zero, not exactly zero, to sidestep float rounding.
    closedPosition(l, "A", T0, "flat", { solAmount: 0.1021 });
    const p = l.pctSummary()!;
    expect(p.winRatePct).toBe(1);
    expect(p.avgWinPct).toBeGreaterThan(0);
    expect(p.avgWinPct).toBeCloseTo(0, 2);
  });
});

describe("credit accounting", () => {
  it("accumulates credits per UTC day", () => {
    const l = new Ledger(":memory:");
    expect(l.creditsUsed("2026-09-21")).toBe(0);
    l.addCredits("2026-09-21", 100);
    l.addCredits("2026-09-21", 50.5);
    l.addCredits("2026-09-22", 7);
    expect(l.creditsUsed("2026-09-21")).toBeCloseTo(150.5, 9);
    expect(l.creditsUsed("2026-09-22")).toBe(7);
  });
});
