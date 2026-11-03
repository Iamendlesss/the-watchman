import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { PaperExecutor, type Quote } from "../src/executor";

const cfg = parseConfig({});
const ex = new PaperExecutor(cfg);
const q: Quote = { mint: "M", symbol: "M", midPriceSol: 0.0001, liquiditySol: 50 };

describe("paper executor", () => {
  it("buys fewer tokens than the mid price implies (price impact + extra slippage)", () => {
    const r = ex.buy(q, 0.09);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fill.tokens).toBeLessThan(0.09 / q.midPriceSol);
    expect(r.fill.priceSol).toBeGreaterThan(q.midPriceSol);
    expect(r.fill.rentSol).toBeCloseTo(cfg.fees.ataRentSol, 10);
    expect(r.fill.feesSol).toBeCloseTo(0.000005 + 0.0005 + 0.000005, 10);
  });

  it("a round trip at an unchanged price always loses money", () => {
    const b = ex.buy(q, 0.09);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const s = ex.sell(q, b.fill.tokens, { closing: true });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const net = s.fill.solAmount - s.fill.feesSol - (b.fill.solAmount + b.fill.feesSol);
    expect(net).toBeLessThan(0);
  });

  it("returns the rent deposit only when closing", () => {
    const partial = ex.sell(q, 1000);
    const closing = ex.sell(q, 1000, { closing: true });
    expect(partial.ok && partial.fill.rentSol).toBe(0);
    expect(closing.ok && closing.fill.rentSol).toBeCloseTo(-cfg.fees.ataRentSol, 10);
  });

  it("rejects fills whose slippage exceeds the cap", () => {
    const thin: Quote = { ...q, liquiditySol: 0.5 };
    const r = ex.buy(thin, 0.2);
    expect(r.ok).toBe(false);
  });

  it("rejects invalid inputs", () => {
    expect(ex.buy(q, 0).ok).toBe(false);
    expect(ex.sell({ ...q, midPriceSol: 0 }, 10).ok).toBe(false);
  });

  it("the round-trip cost estimate is close to what a simulated round trip actually costs", () => {
    const size = 0.09;
    const est = ex.estimateRoundTripCostSol(size, q.liquiditySol);
    const b = ex.buy(q, size);
    if (!b.ok) throw new Error("buy failed");
    const s = ex.sell(q, b.fill.tokens, { closing: true });
    if (!s.ok) throw new Error("sell failed");
    const actual = b.fill.solAmount + b.fill.feesSol - (s.fill.solAmount - s.fill.feesSol);
    expect(Math.abs(est - actual)).toBeLessThan(1e-9);
  });
});

describe("paper executor with a venue fee (pump.fun bonding curve)", () => {
  const curve: Quote = { mint: "M", symbol: "M", midPriceSol: 3e-8, liquiditySol: 40, tradeFeePct: 0.0125 };

  it("takes the venue fee on both legs and reports it in the fees", () => {
    const b = ex.buy(curve, 0.1);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.fill.solAmount).toBeCloseTo(0.1 * (1 - 0.0125), 12); // only this much reaches the curve
    expect(b.fill.feesSol).toBeCloseTo(0.1 * 0.0125 + 0.00051, 10); // venue fee + network fees (0.000005 + 0.0005 + 0.000005)
    const s = ex.sell(curve, b.fill.tokens);
    if (!s.ok) throw new Error("sell failed");
    expect(s.fill.feesSol).toBeCloseTo(s.fill.solAmount * 0.0125 + 0.00051, 10);
  });

  it("matches pump.fun's constant-product formula exactly when the extra slippage is zero", () => {
    const exact = new PaperExecutor(parseConfig({ paper: { extraSlippagePct: 0 } }));
    const vSol = 40, vTok = vSol / 3e-8 * 1e6; // raw token units, 6 decimals
    const b = exact.buy(curve, 0.5);
    if (!b.ok) throw new Error("buy failed");
    const swapIn = 0.5 * (1 - 0.0125);
    const programTokens = (vTok * swapIn) / (vSol + swapIn) / 1e6; // whole tokens: dy = y*dx/(x+dx)
    expect(b.fill.tokens / programTokens).toBeCloseTo(1, 9);
  });

  it("estimate includes the venue fee and matches a simulated round trip", () => {
    const size = 0.1;
    const est = ex.estimateRoundTripCostSol(size, curve.liquiditySol, 0.0125);
    const b = ex.buy(curve, size);
    if (!b.ok) throw new Error("buy failed");
    const s = ex.sell(curve, b.fill.tokens, { closing: true });
    if (!s.ok) throw new Error("sell failed");
    const actual = b.fill.solAmount + b.fill.feesSol - (s.fill.solAmount - s.fill.feesSol);
    expect(Math.abs(est - actual)).toBeLessThan(1e-9);
    expect(est).toBeGreaterThan(2 * 0.0125 * size); // at least the two venue fees
  });

  it("an emergency exit accepts slippage that a normal sell refuses", () => {
    const thin: Quote = { ...curve, liquiditySol: 0.5 };
    const tokens = 0.4 / thin.midPriceSol; // a position as large as the pool's SOL
    expect(ex.sell(thin, tokens).ok).toBe(false);
    const forced = ex.sell(thin, tokens, { closing: true, force: true });
    expect(forced.ok).toBe(true);
  });
});
