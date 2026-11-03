import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { decideExit, type ExitInputs } from "../src/strategy/exits";

const cfg = parseConfig({});
const MIN = 60_000;
const base: ExitInputs = {
  strategy: "snipe", entryPrice: 1, peakPrice: 1, price: 1, recoveredInitial: false, ageMs: 5 * MIN, creatorSoldPct: 0, graduated: false,
};
const d = (o: Partial<ExitInputs>) => decideExit({ ...base, ...o }, cfg);

describe("exit rules", () => {
  it("holds a quiet position", () => {
    expect(d({})).toEqual({ action: "hold" });
    expect(d({ price: 1.5, peakPrice: 1.5 })).toEqual({ action: "hold" });
  });

  it("hard stop-loss at 25% below entry, inclusive", () => {
    expect(d({ price: 0.76 })).toEqual({ action: "hold" });
    expect(d({ price: 0.75 })).toMatchObject({ action: "sell", fraction: 1, reason: "hard stop-loss" });
  });

  it("recovers the initial stake at 2x by selling half, once", () => {
    const r = d({ price: 2, peakPrice: 2 });
    expect(r).toMatchObject({ action: "sell", fraction: 0.5, reason: "initial recovery at 2x", markRecovered: true });
    expect(d({ price: 2.5, peakPrice: 2.5, recoveredInitial: true })).toEqual({ action: "hold" });
  });

  it("does not trail before the stake is recovered", () => {
    // fell 25% from a 1.9x peak, still above the hard stop, and never reached 2x
    expect(d({ price: 1.42, peakPrice: 1.9 })).toEqual({ action: "hold" });
  });

  it("trails 25% below the peak after recovery, as a backstop below the second target", () => {
    expect(d({ recoveredInitial: true, peakPrice: 3.9, price: 3.1 })).toEqual({ action: "hold" });
    expect(d({ recoveredInitial: true, peakPrice: 3.9, price: 2.9 })).toMatchObject({ action: "sell", fraction: 1, reason: "trailing stop" });
  });

  it("sells the remainder in full at the second target (4x entry with defaults), ahead of the trailing stop", () => {
    expect(d({ recoveredInitial: true, peakPrice: 3.9, price: 3.99 })).toEqual({ action: "hold" });
    expect(d({ recoveredInitial: true, peakPrice: 4, price: 4 })).toMatchObject({ action: "sell", fraction: 1, reason: "second target at 4x" });
    // reaching the target directly from a lower peak (price and peak move together in real ticks) still exits in full
    expect(d({ recoveredInitial: true, peakPrice: 4.5, price: 4.5 })).toMatchObject({ action: "sell", fraction: 1, reason: "second target at 4x" });
  });

  it("a custom secondTargetMultiple changes the target (recovery x second, not a fixed 4x)", () => {
    const tightCfg = parseConfig({ exits: { secondTargetMultiple: 1.5 } }); // 2 x 1.5 = 3x entry
    const dd = (o: Partial<ExitInputs>) => decideExit({ ...base, ...o }, tightCfg);
    expect(dd({ recoveredInitial: true, peakPrice: 2.9, price: 2.9 })).toEqual({ action: "hold" });
    expect(dd({ recoveredInitial: true, peakPrice: 3, price: 3 })).toMatchObject({ reason: "second target at 3x" });
  });

  it("time stop sells a coin that has not gained 20% by the deadline, but keeps a winner", () => {
    expect(d({ ageMs: 29 * MIN, price: 1.05 })).toEqual({ action: "hold" });
    expect(d({ ageMs: 30 * MIN, price: 1.05 })).toMatchObject({ action: "sell", reason: "time stop" });
    expect(d({ ageMs: 31 * MIN, price: 1.3, peakPrice: 1.3 })).toEqual({ action: "hold" });
    expect(d({ ageMs: 60 * MIN, price: 1.05, strategy: "momentum" })).toEqual({ action: "hold" }); // momentum deadline is 120 min
    expect(d({ ageMs: 120 * MIN, price: 1.05, strategy: "momentum" })).toMatchObject({ reason: "time stop" });
  });

  it("time stop no longer applies after recovery (the trailing stop manages the remainder)", () => {
    expect(d({ ageMs: 90 * MIN, price: 1.6, peakPrice: 2, recoveredInitial: true })).toEqual({ action: "hold" });
  });

  it("exits at once when the creator dumps", () => {
    expect(d({ creatorSoldPct: 0.49 })).toEqual({ action: "hold" });
    expect(d({ creatorSoldPct: 0.5 })).toMatchObject({ action: "sell", fraction: 1, reason: "creator dump" });
  });

  it("exits when the coin graduates, ahead of every other rule", () => {
    expect(d({ graduated: true, price: 3 })).toMatchObject({ reason: "graduated" });
    expect(d({ graduated: true, creatorSoldPct: 0.9, price: 0.1 })).toMatchObject({ reason: "graduated" });
  });

  it("checks the hard stop before the recovery rule", () => {
    expect(d({ price: 0.5, peakPrice: 3 })).toMatchObject({ reason: "hard stop-loss" });
  });
});
