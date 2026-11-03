import type { Config } from "./config";
import type { Fill } from "./ledger";

/** What the market looks like right now for one token. */
export interface Quote {
  mint: string;
  symbol: string;
  /** Mid price in SOL per token. */
  midPriceSol: number;
  /**
   * SOL-side liquidity of the pool. Drives the price-impact model. For a pump.fun bonding curve this is the
   * VIRTUAL SOL reserve, and `midPriceSol` is virtual SOL / virtual tokens, which makes the constant-product
   * model below identical to the program's own buy and sell formulas.
   */
  liquiditySol: number;
  /** Protocol + creator fee as a fraction of the trade (0.0125 = 1.25%). Omitted means no venue fee. */
  tradeFeePct?: number;
}

export type ExecResult =
  | { ok: true; fill: Fill }
  | { ok: false; reason: string; slippagePct: number };

/** The interface the live executor will implement in a later phase. */
export interface Executor {
  buy(q: Quote, sizeSol: number): ExecResult;
  sell(q: Quote, tokens: number, opts?: { closing?: boolean; force?: boolean }): ExecResult;
  estimateRoundTripCostSol(sizeSol: number, liquiditySol: number, tradeFeePct?: number): number;
  /** Total SOL a buy costs on top of the swap amount: leg fees plus the token-account rent deposit. */
  buyOverheadSol(): number;
}

/**
 * Paper executor. Simulates fills with a constant-product price-impact model plus a pessimistic extra
 * slippage haircut and realistic per-leg fees. It never touches a network or a key.
 * It is a model: real pools (especially pump.fun bonding curves) differ, which is why the paper week
 * compares this model against a few tiny live trades before any real money is used.
 */
export class PaperExecutor implements Executor {
  constructor(private readonly cfg: Config) {}

  private legFeesSol(): number {
    const f = this.cfg.fees;
    return f.baseFeeSol + f.priorityFeeSol + f.senderTipSol;
  }

  buyOverheadSol(): number {
    return this.legFeesSol() + this.cfg.fees.ataRentSol;
  }

  /** Estimated total cost of buying and later selling `sizeSol` (fees, price impact, extra slippage). Rent is refundable and excluded. */
  estimateRoundTripCostSol(sizeSol: number, liquiditySol: number, tradeFeePct = 0): number {
    const extra = this.cfg.paper.extraSlippagePct;
    const netIn = sizeSol * (1 - tradeFeePct);
    const buyShortfall = 1 - (liquiditySol / (liquiditySol + netIn)) * (1 - extra);
    const valueAfterBuy = netIn * (1 - buyShortfall);
    const grossOut = (valueAfterBuy / (1 + valueAfterBuy / liquiditySol)) * (1 - extra);
    const sellProceeds = grossOut * (1 - tradeFeePct);
    return sizeSol - sellProceeds + 2 * this.legFeesSol();
  }

  buy(q: Quote, sizeSol: number): ExecResult {
    if (!(sizeSol > 0) || !(q.midPriceSol > 0) || !(q.liquiditySol > 0)) {
      return { ok: false, reason: "invalid quote or size", slippagePct: 0 };
    }
    const R = q.liquiditySol;
    const extra = this.cfg.paper.extraSlippagePct;
    const tradeFee = q.tradeFeePct ?? 0;
    const T = R / q.midPriceSol;
    const venueFee = sizeSol * tradeFee; // taken by the venue before the swap
    const swapIn = sizeSol - venueFee;
    const tokens = ((T * swapIn) / (R + swapIn)) * (1 - extra);
    const shortfall = 1 - (tokens * q.midPriceSol) / swapIn; // price impact and slippage only, not the fee
    if (shortfall > this.cfg.risk.maxSlippagePct) {
      return { ok: false, reason: `slippage ${(shortfall * 100).toFixed(1)}% exceeds cap`, slippagePct: shortfall };
    }
    return {
      ok: true,
      fill: {
        side: "buy",
        tokens,
        priceSol: swapIn / tokens,
        solAmount: swapIn,
        feesSol: this.legFeesSol() + venueFee,
        rentSol: this.cfg.fees.ataRentSol,
        slippagePct: shortfall,
      },
    };
  }

  /** `force` is for emergency exits (stop-loss, creator dump): it accepts any slippage instead of refusing the fill. */
  sell(q: Quote, tokens: number, opts: { closing?: boolean; force?: boolean } = {}): ExecResult {
    if (!(tokens > 0) || !(q.midPriceSol > 0) || !(q.liquiditySol > 0)) {
      return { ok: false, reason: "invalid quote or size", slippagePct: 0 };
    }
    const R = q.liquiditySol;
    const extra = this.cfg.paper.extraSlippagePct;
    const valueMid = tokens * q.midPriceSol;
    const proceeds = (valueMid / (1 + valueMid / R)) * (1 - extra); // gross, before the venue fee
    const shortfall = 1 - proceeds / valueMid;
    if (!opts.force && shortfall > this.cfg.risk.maxSlippagePct) {
      return { ok: false, reason: `slippage ${(shortfall * 100).toFixed(1)}% exceeds cap`, slippagePct: shortfall };
    }
    return {
      ok: true,
      fill: {
        side: "sell",
        tokens,
        priceSol: proceeds / tokens,
        solAmount: proceeds,
        feesSol: this.legFeesSol() + proceeds * (q.tradeFeePct ?? 0),
        rentSol: opts.closing ? -this.cfg.fees.ataRentSol : 0,
        slippagePct: shortfall,
      },
    };
  }
}
