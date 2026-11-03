import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode } from "../src/scanner/borsh";
import { PUMP_PROGRAM } from "../src/scanner/events";
import { LaunchTracker } from "../src/scanner/tracker";
import { UsageMeter } from "../src/scanner/usage";
import { CURVE_TOKENS, SUPPLY, createEv, decoder, eventData, pk, pumpLogs, tradeEv } from "./helpers";

describe("base58", () => {
  it("round-trips and handles leading zeros", () => {
    const zeros = new Uint8Array(32);
    expect(base58Encode(zeros)).toBe("11111111111111111111111111111111");
    expect(Array.from(base58Decode("11111111111111111111111111111111"))).toEqual(Array.from(zeros));
    expect(base58Encode(base58Decode(PUMP_PROGRAM))).toBe(PUMP_PROGRAM);
    expect(base58Decode(PUMP_PROGRAM)).toHaveLength(32);
  });
  it("rejects invalid characters", () => {
    expect(() => base58Decode("0OIl")).toThrow();
  });
});

describe("pump event decoder", () => {
  it("uses the official discriminators from the IDL", () => {
    expect(decoder.discriminator("CreateEvent")).toEqual([27, 114, 169, 77, 222, 235, 99, 118]);
    expect(decoder.discriminator("TradeEvent")).toEqual([189, 219, 127, 211, 78, 230, 97, 238]);
  });

  it("round-trips a CreateEvent through the real IDL layout", () => {
    const ev = createEv(pk(1), pk(2));
    expect(ev.name).toBe("CreateEvent");
    if (ev.name !== "CreateEvent") return;
    expect(ev.data.mint).toBe(pk(1));
    expect(ev.data.creator).toBe(pk(2));
    expect(ev.data.symbol).toBe("TEST");
    expect(ev.data.totalSupply).toBe(SUPPLY);
    expect(ev.data.quoteIsSol).toBe(true); // default quote mint means SOL
    expect(ev.data.mayhem).toBe(false);
  });

  it("flags non-SOL quote mints and mayhem mode", () => {
    const ev = createEv(pk(1), pk(2), { quote_mint: pk(50), is_mayhem_mode: true });
    if (ev.name !== "CreateEvent") throw new Error("wrong event");
    expect(ev.data.quoteIsSol).toBe(false);
    expect(ev.data.mayhem).toBe(true);
  });

  it("counts only protocol plus creator fees as the cost of a trade", () => {
    const ev = tradeEv(pk(1), pk(3), true, 1000n, 10n, { holder_rewards_bps: 5000n, cashback_fee_basis_points: 40n });
    if (ev.name !== "TradeEvent") throw new Error("wrong event");
    // Only protocol + creator fees count as the trader's cost. holder_rewards_bps repeats the creator fee rate
    // on holder-reward coins, so adding it would double count (this was a bug that showed fees as 51%).
    expect(ev.data.totalFeeBps).toBe(95 + 30);
    expect(ev.data.feeFields).toEqual({ fee: 95, creator: 30, cashback: 40, buyback: 0, holderRewards: 5000 });
    expect(ev.data.isBuy).toBe(true);
  });

  it("ignores program data emitted inside another program's frame", () => {
    const data = eventData("TradeEvent", { mint: pk(1), user: pk(3), is_buy: true, token_amount: 5n });
    const logs = [
      `Program ${PUMP_PROGRAM} invoke [1]`,
      "Program OtherProgram11111111111111111111111111111 invoke [2]",
      `Program data: ${data}`,
      "Program OtherProgram11111111111111111111111111111 success",
      `Program ${PUMP_PROGRAM} success`,
    ];
    expect(decoder.decodeLogs(logs)).toHaveLength(0);
  });

  it("decodes several events from one transaction and survives garbage", () => {
    const a = eventData("CreateEvent", { mint: pk(1), creator: pk(2), token_total_supply: SUPPLY });
    const b = eventData("TradeEvent", { mint: pk(1), user: pk(2), is_buy: true, token_amount: 10n });
    const before = decoder.stats.errors;
    const logs = pumpLogs([a, "AAAA", b, Buffer.from("not an anchor event at all").toString("base64")]);
    expect(decoder.decodeLogs(logs).map((e) => e.name)).toEqual(["CreateEvent", "TradeEvent"]);
    expect(decoder.stats.errors).toBeGreaterThanOrEqual(before); // garbage never throws
  });

  it("counts a truncated event as a decode error instead of throwing", () => {
    const good = Buffer.from(eventData("TradeEvent", { mint: pk(1) }), "base64");
    const cut = good.subarray(0, 60).toString("base64");
    const before = decoder.stats.errors;
    expect(decoder.decodeLogs(pumpLogs([cut]))).toHaveLength(0);
    expect(decoder.stats.errors).toBe(before + 1);
  });
});

describe("launch tracker", () => {
  const opts = { observationSeconds: 180, bundleSlots: 2, maxTracked: 100 };
  const MINT = pk(10);
  const DEV = pk(11);
  const T0 = 1_000_000;

  function seeded() {
    const t = new LaunchTracker(opts);
    t.onEvent(createEv(MINT, DEV), 100, T0);
    // dev buys 5% in the create transaction
    t.onEvent(tradeEv(MINT, DEV, true, SUPPLY / 20n, 1_000_000_000n), 100, T0);
    // two bundled wallets buy in the first slots (3% each)
    t.onEvent(tradeEv(MINT, pk(20), true, (SUPPLY * 3n) / 100n, 500_000_000n), 101, T0 + 400);
    t.onEvent(tradeEv(MINT, pk(21), true, (SUPPLY * 3n) / 100n, 500_000_000n), 102, T0 + 800);
    // later organic buyers, outside the bundle window
    for (let i = 0; i < 12; i++) t.onEvent(tradeEv(MINT, pk(100 + i), true, SUPPLY / 200n, 100_000_000n), 200 + i, T0 + 5000 + i);
    return t;
  }

  it("rebuilds balances, buyers and bundled share from the trade stream", () => {
    const t = seeded();
    const s = t.snapshot(t.get(MINT)!, T0 + 60_000);
    expect(s.uniqueBuyers).toBe(15);
    expect(s.buyCount).toBe(15);
    expect(s.creatorPct).toBeCloseTo(0.05, 4);
    expect(s.bundledPct).toBeCloseTo(0.06, 4);
    // top 10: dev 5% + two 3% + seven 0.5% = 14.5%
    expect(s.top10Pct).toBeCloseTo(0.145, 4);
    expect(s.priceSol).toBeGreaterThan(0);
  });

  it("tracks the creator selling their own purchases", () => {
    const t = seeded();
    t.onEvent(tradeEv(MINT, DEV, false, SUPPLY / 40n, 400_000_000n), 300, T0 + 30_000); // sells half
    const s = t.snapshot(t.get(MINT)!, T0 + 60_000);
    expect(s.creatorSoldPct).toBeCloseTo(0.5, 4);
    expect(s.creatorPct).toBeCloseTo(0.025, 4);
    expect(s.sellCount).toBe(1);
  });

  it("never lets a balance go negative when it sees a sell it never saw the buy for", () => {
    const t = seeded();
    t.onEvent(tradeEv(MINT, pk(77), false, 999n, 1n), 300, T0 + 1000);
    const s = t.snapshot(t.get(MINT)!, T0 + 2000);
    expect(s.top10Pct).toBeGreaterThan(0);
  });

  it("ignores trades on tokens it never saw launch", () => {
    const t = new LaunchTracker(opts);
    t.onEvent(tradeEv(pk(999), pk(1), true, 100n, 1n), 5, T0);
    expect(t.counters.trades).toBe(0);
  });

  it("releases tokens only after the observation window", () => {
    const t = seeded();
    expect(t.due(T0 + 179_000)).toHaveLength(0);
    expect(t.due(T0 + 181_000).map((x) => x.mint)).toEqual([MINT]);
    t.markEvaluated(MINT);
    expect(t.due(T0 + 500_000)).toHaveLength(0);
  });

  it("caps memory by evicting the oldest tracked token", () => {
    const t = new LaunchTracker({ ...opts, maxTracked: 3 });
    for (let i = 0; i < 5; i++) t.onEvent(createEv(pk(300 + i), pk(400 + i)), 100 + i, T0 + i);
    expect(t.size).toBe(3);
    expect(t.counters.evicted).toBe(2);
    expect(t.get(pk(300))).toBeUndefined();
    expect(t.get(pk(304))).toBeDefined();
  });

  it("computes curve progress from tokens sold out of the curve", () => {
    const t = new LaunchTracker(opts);
    t.onEvent(createEv(MINT, DEV), 100, T0);
    t.onEvent(tradeEv(MINT, pk(5), true, CURVE_TOKENS / 4n, 8_000_000_000n), 101, T0 + 10);
    expect(t.snapshot(t.get(MINT)!, T0 + 20).progressPct).toBeCloseTo(0.25, 3);
  });

  it("stores the create signature and offers coins for the early check exactly once", () => {
    const t = new LaunchTracker(opts);
    t.onEvent(createEv(MINT, DEV), 100, T0, "CREATE_SIG");
    expect(t.get(MINT)!.createSignature).toBe("CREATE_SIG");
    expect(t.dueEarly(T0 + 59_000, 60)).toHaveLength(0);
    expect(t.dueEarly(T0 + 61_000, 60).map((x) => x.mint)).toEqual([MINT]);
    t.markEarlyChecked(MINT);
    expect(t.dueEarly(T0 + 90_000, 60)).toHaveLength(0);
    expect(t.due(T0 + 181_000)).toHaveLength(1); // still due for the final judgement
  });

  it("does not let an older, backfilled trade overwrite newer reserves", () => {
    const t = new LaunchTracker(opts);
    t.onEvent(createEv(MINT, DEV), 100, T0);
    t.onEvent(tradeEv(MINT, pk(5), true, 1000n, 1n, { real_sol_reserves: 9_000_000_000n }), 150, T0 + 5);
    t.onEvent(tradeEv(MINT, pk(6), true, 1000n, 1n, { real_sol_reserves: 1_000_000_000n }), 101, T0 + 6); // older slot, arrives late
    expect(t.snapshot(t.get(MINT)!, T0 + 10).realSol).toBeCloseTo(9, 6);
    expect(t.snapshot(t.get(MINT)!, T0 + 10).uniqueBuyers).toBe(2); // but its buyer still counts
  });

  it("records observed fee rates and marks completion", () => {
    const t = seeded();
    expect(t.feeBpsSeen.length).toBeGreaterThan(0);
    expect(t.feeBpsSeen[0]).toBe(125);
    expect(t.feeFieldSamples.fee[0]).toBe(95);
    expect(t.feeFieldSamples.creator[0]).toBe(30);
    t.onEvent({ name: "CompleteEvent", data: { mint: MINT } }, 400, T0 + 9000);
    expect(t.get(MINT)!.complete).toBe(true);
  });
});

describe("usage meter", () => {
  it("projects monthly Helius credits from streamed bytes", () => {
    let now = 0;
    const m = new UsageMeter(() => now);
    m.add(1_000_000); // 1 MB
    now = 60_000; // over one minute
    const r = m.report(1_000_000);
    expect(r.creditsUsed).toBeCloseTo(20, 6); // 1 MB = 10 x 0.1 MB = 20 credits
    expect(r.creditsPerMonth).toBeCloseTo(20 * 60 * 24 * 30, 0);
    expect(r.fractionOfFreePlan).toBeCloseTo((20 * 43200) / 1_000_000, 5);
  });
  it("charges no Helius credits for a stream from another provider, but still counts the data and RPC calls", () => {
    let now = 0;
    const m = new UsageMeter(() => now, false);
    m.add(1_000_000);
    m.addRpc(4);
    now = 60_000;
    const r = m.report();
    expect(r.megabytes).toBeCloseTo(1, 9);
    expect(r.streamCredits).toBe(0);
    expect(r.creditsUsed).toBe(4);
  });
  it("adds RPC calls to the credit total", () => {
    let now = 0;
    const m = new UsageMeter(() => now);
    m.add(1_000_000);
    m.addRpc(30);
    now = 60_000;
    const r = m.report();
    expect(r.rpcCalls).toBe(30);
    expect(r.streamCredits).toBeCloseTo(20, 6);
    expect(r.creditsUsed).toBeCloseTo(50, 6);
  });
});
