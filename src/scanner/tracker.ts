import type { CreateEvent, PumpEvent, TradeEvent } from "./events";

export interface TrackerOptions {
  observationSeconds: number;
  bundleSlots: number;
  maxTracked: number;
}

export type FeeField = "fee" | "creator" | "cashback" | "buyback" | "holderRewards";

export interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  bondingCurve: string;
  createdAtMs: number;
  createSlot: number;
  /** Signature of the create transaction. Used to backfill trades that landed before our subscription started. */
  createSignature: string;
  totalSupply: bigint;
  initialRealTokens: bigint;
  quoteIsSol: boolean;
  mayhem: boolean;
  tokenProgram: string;
  /** Net tokens per wallet, rebuilt from trade events. A fresh launch starts with everything in the curve. */
  balances: Map<string, bigint>;
  buyers: Set<string>;
  buyCount: number;
  sellCount: number;
  bundleBuys: Map<string, bigint>;
  creatorBought: bigint;
  creatorSold: bigint;
  vSol: bigint;
  vToken: bigint;
  rSol: bigint;
  rToken: bigint;
  lastFeeBps: number;
  /** Mid price at launch, in SOL per whole token, from the create event's virtual reserves. */
  launchPriceSol: number;
  /** Slot of the newest trade applied to the reserves, so late-arriving older trades cannot make them stale. */
  lastSlot: number;
  complete: boolean;
  evaluated: boolean;
  earlyChecked: boolean;
}

/** Everything the safety gate needs, as plain numbers. */
export interface Snapshot {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  ageSec: number;
  uniqueBuyers: number;
  buyCount: number;
  sellCount: number;
  top10Pct: number;
  creatorPct: number;
  /** Share of the creator's own purchases that the creator has since sold (0 if the creator never bought). */
  creatorSoldPct: number;
  bundledPct: number;
  realSol: number;
  progressPct: number;
  quoteIsSol: boolean;
  mayhem: boolean;
  tokenProgram: string;
  /** Mid price in SOL per whole token (6 decimals assumed for pump.fun tokens). */
  priceSol: number;
  /** Price at launch, and how many times higher the price is now. */
  launchPriceSol: number;
  runupMultiple: number;
}

const frac = (a: bigint, b: bigint): number => (b <= 0n ? 0 : Number((a * 1_000_000n) / b) / 1_000_000);

export class LaunchTracker {
  private readonly tokens = new Map<string, TokenState>();
  readonly counters = { launches: 0, trades: 0, completes: 0, evicted: 0 };
  /** Fee rates (protocol + creator, in bps) seen on trades of tracked tokens, for calibrating the cost model. */
  readonly feeBpsSeen: number[] = [];
  /** Each fee field separately, so the scan can show what every one of them really is. */
  readonly feeFieldSamples: Record<FeeField, number[]> = { fee: [], creator: [], cashback: [], buyback: [], holderRewards: [] };

  constructor(private readonly opts: TrackerOptions) {}

  get size(): number {
    return this.tokens.size;
  }

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  onEvent(ev: PumpEvent, slot: number, nowMs: number, signature = ""): void {
    if (ev.name === "CreateEvent") this.onCreate(ev.data, slot, nowMs, signature);
    else if (ev.name === "TradeEvent") this.onTrade(ev.data, slot);
    else {
      const t = this.tokens.get(ev.data.mint);
      if (t) {
        t.complete = true;
        this.counters.completes++;
      }
    }
  }

  private onCreate(c: CreateEvent, slot: number, nowMs: number, signature: string): void {
    if (this.tokens.has(c.mint)) return;
    if (this.tokens.size >= this.opts.maxTracked) this.evictOldest();
    this.counters.launches++;
    this.tokens.set(c.mint, {
      mint: c.mint,
      name: c.name,
      symbol: c.symbol,
      creator: c.creator,
      bondingCurve: c.bondingCurve,
      createdAtMs: nowMs,
      createSlot: slot,
      createSignature: signature,
      totalSupply: c.totalSupply,
      initialRealTokens: c.realTokenReserves,
      quoteIsSol: c.quoteIsSol,
      mayhem: c.mayhem,
      tokenProgram: c.tokenProgram,
      balances: new Map(),
      buyers: new Set(),
      buyCount: 0,
      sellCount: 0,
      bundleBuys: new Map(),
      creatorBought: 0n,
      creatorSold: 0n,
      vSol: c.virtualSolReserves,
      vToken: c.virtualTokenReserves,
      rSol: 0n,
      rToken: c.realTokenReserves,
      lastFeeBps: 0,
      launchPriceSol: c.virtualTokenReserves > 0n ? Number(c.virtualSolReserves) / 1e9 / (Number(c.virtualTokenReserves) / 1e6) : 0,
      lastSlot: slot,
      complete: false,
      evaluated: false,
      earlyChecked: false,
    });
  }

  private onTrade(e: TradeEvent, slot: number): void {
    const t = this.tokens.get(e.mint);
    if (!t) return;
    this.counters.trades++;
    if (slot >= t.lastSlot) {
      t.lastSlot = slot;
      t.vSol = e.virtualSolReserves;
      t.vToken = e.virtualTokenReserves;
      t.rSol = e.realSolReserves;
      t.rToken = e.realTokenReserves;
      t.lastFeeBps = e.totalFeeBps;
    }
    if (e.totalFeeBps > 0 && this.feeBpsSeen.length < 200_000) this.feeBpsSeen.push(e.totalFeeBps);
    if (this.feeFieldSamples.fee.length < 50_000) {
      for (const k of Object.keys(this.feeFieldSamples) as FeeField[]) this.feeFieldSamples[k].push(e.feeFields[k]);
    }
    const prev = t.balances.get(e.user) ?? 0n;
    const isCreator = e.user === t.creator;
    if (e.isBuy) {
      t.buyCount++;
      t.buyers.add(e.user);
      t.balances.set(e.user, prev + e.tokenAmount);
      if (isCreator) t.creatorBought += e.tokenAmount;
      else if (slot - t.createSlot <= this.opts.bundleSlots) {
        t.bundleBuys.set(e.user, (t.bundleBuys.get(e.user) ?? 0n) + e.tokenAmount);
      }
    } else {
      t.sellCount++;
      // A wallet can sell tokens it received by transfer, which the stream never showed as a buy; never go negative.
      t.balances.set(e.user, prev > e.tokenAmount ? prev - e.tokenAmount : 0n);
      if (isCreator) t.creatorSold += e.tokenAmount;
    }
  }

  snapshot(t: TokenState, nowMs: number): Snapshot {
    const sorted = [...t.balances.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    let top10 = 0n;
    for (const v of sorted.slice(0, 10)) top10 += v;
    let bundled = 0n;
    for (const v of t.bundleBuys.values()) bundled += v;
    const creatorBal = t.balances.get(t.creator) ?? 0n;
    const soldFromCurve = t.initialRealTokens > t.rToken ? t.initialRealTokens - t.rToken : 0n;
    const price = t.vToken > 0n ? Number(t.vSol) / 1e9 / (Number(t.vToken) / 1e6) : 0;
    return {
      mint: t.mint,
      symbol: t.symbol,
      name: t.name,
      creator: t.creator,
      ageSec: (nowMs - t.createdAtMs) / 1000,
      uniqueBuyers: t.buyers.size,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      top10Pct: frac(top10, t.totalSupply),
      creatorPct: frac(creatorBal, t.totalSupply),
      creatorSoldPct: t.creatorBought > 0n ? frac(t.creatorSold, t.creatorBought) : 0,
      bundledPct: frac(bundled, t.totalSupply),
      realSol: Number(t.rSol) / 1e9,
      progressPct: frac(soldFromCurve, t.initialRealTokens),
      quoteIsSol: t.quoteIsSol,
      mayhem: t.mayhem,
      tokenProgram: t.tokenProgram,
      priceSol: price,
      launchPriceSol: t.launchPriceSol,
      runupMultiple: t.launchPriceSol > 0 ? price / t.launchPriceSol : 0,
    };
  }

  /** Tokens whose observation window has elapsed and that have not been judged yet. */
  due(nowMs: number): TokenState[] {
    const out: TokenState[] = [];
    for (const t of this.tokens.values()) {
      if (!t.evaluated && nowMs - t.createdAtMs >= this.opts.observationSeconds * 1000) out.push(t);
    }
    return out;
  }

  /** Tokens old enough for the early traction check that have not had it yet. */
  dueEarly(nowMs: number, earlySeconds: number): TokenState[] {
    const out: TokenState[] = [];
    for (const t of this.tokens.values()) {
      if (!t.evaluated && !t.earlyChecked && nowMs - t.createdAtMs >= earlySeconds * 1000) out.push(t);
    }
    return out;
  }

  markEarlyChecked(mint: string): void {
    const t = this.tokens.get(mint);
    if (t) t.earlyChecked = true;
  }

  markEvaluated(mint: string): void {
    const t = this.tokens.get(mint);
    if (t) t.evaluated = true;
  }

  release(mint: string): void {
    this.tokens.delete(mint);
  }

  private evictOldest(): void {
    let oldest: TokenState | undefined;
    for (const t of this.tokens.values()) if (!oldest || t.createdAtMs < oldest.createdAtMs) oldest = t;
    if (oldest) {
      this.tokens.delete(oldest.mint);
      this.counters.evicted++;
    }
  }
}
