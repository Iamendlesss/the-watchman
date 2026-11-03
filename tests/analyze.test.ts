import { describe, expect, it } from "vitest";
import { analyzeEntries, FIELD_EDGES, type EntryRow } from "../src/analyze";

const snap = (over: Record<string, number> = {}) =>
  JSON.stringify({ runupMultiple: 1.5, top10Pct: 0.2, bundledPct: 0.02, uniqueBuyers: 40, realSol: 15, ...over });

describe("FIELD_EDGES", () => {
  it("covers every real number with no gaps and no overlaps, per field", () => {
    for (const [field, edges] of Object.entries(FIELD_EDGES)) {
      expect(edges[0]!.min).toBe(-Infinity);
      expect(edges.at(-1)!.max).toBe(Infinity);
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]!.min, `${field} bucket ${i}`).toBe(edges[i - 1]!.max);
      }
    }
  });
});

describe("analyzeEntries", () => {
  it("surfaces a planted pattern: high run-up entries fail far more than low run-up ones", () => {
    const rows: EntryRow[] = [];
    // 10 low-run-up entries, mostly winners
    for (let i = 0; i < 10; i++) {
      rows.push({ pnlPct: i < 7 ? 0.5 : -0.3, exitReason: i < 7 ? "trailing stop" : "hard stop-loss", gateSnapshot: snap({ runupMultiple: 1.2 }) });
    }
    // 10 high-run-up entries, mostly hard stops
    for (let i = 0; i < 10; i++) {
      rows.push({ pnlPct: i < 2 ? 0.1 : -0.3, exitReason: i < 2 ? "graduated" : "hard stop-loss", gateSnapshot: snap({ runupMultiple: 9 }) });
    }
    const { breakdowns, parsed, skipped } = analyzeEntries(rows);
    expect(parsed).toBe(20);
    expect(skipped).toBe(0);

    const runup = breakdowns.find((b) => b.field === "runupMultiple")!;
    const low = runup.buckets.find((b) => b.label === "<2x")!;
    const high = runup.buckets.find((b) => b.label === "8x+")!;
    expect(low.count).toBe(10);
    expect(high.count).toBe(10);
    expect(low.winRatePct).toBeCloseTo(0.7, 9);
    expect(high.winRatePct).toBeCloseTo(0.2, 9);
    expect(low.hardStopRatePct).toBeCloseTo(0.3, 9);
    expect(high.hardStopRatePct).toBeCloseTo(0.8, 9);
    expect(high.avgPct).toBeLessThan(low.avgPct);
  });

  it("buckets boundary values correctly (min inclusive, max exclusive except the top bucket)", () => {
    const rows: EntryRow[] = [
      { pnlPct: 0, exitReason: "x", gateSnapshot: snap({ runupMultiple: 2 }) }, // lands in 2-4x, not <2x
      { pnlPct: 0, exitReason: "x", gateSnapshot: snap({ runupMultiple: 1.999 }) }, // lands in <2x
      { pnlPct: 0, exitReason: "x", gateSnapshot: snap({ runupMultiple: 8 }) }, // lands in 8x+ (top bucket, inclusive)
    ];
    const runup = analyzeEntries(rows).breakdowns.find((b) => b.field === "runupMultiple")!;
    expect(runup.buckets.find((b) => b.label === "<2x")!.count).toBe(1);
    expect(runup.buckets.find((b) => b.label === "2-4x")!.count).toBe(1);
    expect(runup.buckets.find((b) => b.label === "8x+")!.count).toBe(1);
  });

  it("counts a breakeven trade as a win, same convention as pctSummary", () => {
    const rows: EntryRow[] = [{ pnlPct: 0, exitReason: "x", gateSnapshot: snap() }];
    const runup = analyzeEntries(rows).breakdowns.find((b) => b.field === "runupMultiple")!;
    expect(runup.buckets.find((b) => b.label === "<2x")!.winRatePct).toBe(1);
  });

  it("skips rows with no snapshot, and counts them separately from field-level gaps", () => {
    const rows: EntryRow[] = [
      { pnlPct: 0.1, exitReason: "x", gateSnapshot: null }, // no snapshot at all (e.g. the demo command)
      { pnlPct: 0.1, exitReason: "x", gateSnapshot: "not json" }, // corrupt
      { pnlPct: 0.1, exitReason: "x", gateSnapshot: JSON.stringify({ top10Pct: 0.2 }) }, // parses, but missing runupMultiple
      { pnlPct: 0.1, exitReason: "x", gateSnapshot: snap() }, // complete
    ];
    const { breakdowns, parsed, skipped } = analyzeEntries(rows);
    expect(parsed).toBe(2); // the two that parsed as JSON
    expect(skipped).toBe(2); // null + corrupt
    const runup = breakdowns.find((b) => b.field === "runupMultiple")!;
    expect(runup.skipped).toBe(1); // parsed but missing this one field
    expect(runup.buckets.reduce((n, b) => n + b.count, 0)).toBe(1);
    const top10 = breakdowns.find((b) => b.field === "top10Pct")!;
    expect(top10.buckets.reduce((n, b) => n + b.count, 0)).toBe(2); // both parsed rows have top10Pct
  });

  it("returns an empty, well-formed result for no trades", () => {
    const { breakdowns, parsed, skipped } = analyzeEntries([]);
    expect(parsed).toBe(0);
    expect(skipped).toBe(0);
    for (const b of breakdowns) expect(b.buckets.every((x) => x.count === 0)).toBe(true);
  });
});
