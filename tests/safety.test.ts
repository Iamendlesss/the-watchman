import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { evaluateStreamGate, launchTimeRule } from "../src/safety/gate";
import type { CreateEvent } from "../src/scanner/events";
import { DANGEROUS_EXTENSIONS, evaluateMintInfo, fetchMintInfo, parseMintAccount } from "../src/safety/mintCheck";
import { judge } from "../src/safety/pipeline";
import { TokenBucket, fetchRugcheck, summarizeRugcheck } from "../src/safety/rugcheck";
import type { Snapshot } from "../src/scanner/tracker";

const cfg = parseConfig({});
const good: Snapshot = {
  mint: "MINT", symbol: "GOOD", name: "Good", creator: "DEV", ageSec: 180,
  uniqueBuyers: 30, buyCount: 60, sellCount: 20, top10Pct: 0.1, creatorPct: 0.05, creatorSoldPct: 0,
  bundledPct: 0.05, realSol: 30, progressPct: 0.1, quoteIsSol: true, mayhem: false, tokenProgram: "Tokenz", priceSol: 3e-8, launchPriceSol: 2.8e-8, runupMultiple: 1.07,
};
const fails = (over: Partial<Snapshot>) => evaluateStreamGate({ ...good, ...over }, cfg).failed;

describe("stream gate", () => {
  it("passes a healthy launch", () => {
    const r = evaluateStreamGate(good, cfg);
    expect(r.pass).toBe(true);
    expect(r.failed).toEqual([]);
  });
  it("rejects each bad signal on its own", () => {
    expect(fails({ quoteIsSol: false })).toEqual(["QUOTE_SOL"]);
    expect(fails({ mayhem: true })).toEqual(["MAYHEM_MODE"]);
    expect(fails({ top10Pct: 0.16 })).toEqual(["TOP10_HOLDERS"]);
    expect(fails({ creatorPct: 0.21 })).toEqual(["CREATOR_HOLD"]);
    expect(fails({ creatorSoldPct: 0.3 })).toEqual(["CREATOR_SOLD"]);
    expect(fails({ bundledPct: 0.3 })).toEqual(["BUNDLED"]);
    expect(fails({ uniqueBuyers: 14 })).toEqual(["UNIQUE_BUYERS"]);
    expect(fails({ buyCount: 10, sellCount: 20 })).toEqual(["BUY_SELL_RATIO"]);
    expect(fails({ realSol: 19.9 })).toEqual(["CURVE_SOL"]);
  });
  it("rejects coins already near the pump.fun graduation cap", () => {
    expect(fails({ realSol: 55.1 })).toEqual(["CURVE_SOL_MAX"]);
    expect(fails({ realSol: 55 })).toEqual([]); // inclusive
    expect(fails({ realSol: 84 })).toEqual(["CURVE_SOL_MAX"]); // the near-graduation entries this rule targets
  });
  it("treats zero sells as a passing buy/sell ratio", () => {
    expect(fails({ sellCount: 0 })).toEqual([]);
  });
  it("uses the boundary values as inclusive", () => {
    expect(fails({ top10Pct: 0.15, uniqueBuyers: 15, realSol: 20 })).toEqual([]);
    expect(fails({ realSol: 55 })).toEqual([]); // upper curve-size boundary, inclusive
  });
  it("reports every failing rule", () => {
    expect(fails({ top10Pct: 0.9, bundledPct: 0.9, uniqueBuyers: 1 }).sort()).toEqual(["BUNDLED", "TOP10_HOLDERS", "UNIQUE_BUYERS"]);
    // a coin far past the graduation cap fails both the max-curve rule and, incidentally, nothing else here
    expect(fails({ realSol: 200 })).toEqual(["CURVE_SOL_MAX"]);
  });
  it("honors config switches", () => {
    const off = parseConfig({ safety: { rejectMayhemMode: false, requireSolQuote: false } });
    expect(evaluateStreamGate({ ...good, mayhem: true, quoteIsSol: false }, off).pass).toBe(true);
  });
});

const mintJson = (info: Record<string, unknown>) => ({
  result: { value: { data: { program: "spl-token-2022", parsed: { type: "mint", info } } } },
});

describe("mint check", () => {
  it("parses authorities and extensions from a jsonParsed account", () => {
    const m = parseMintAccount(mintJson({ mintAuthority: null, freezeAuthority: null, extensions: [{ extension: "metadataPointer" }] }));
    expect(m).toEqual({ mintAuthority: null, freezeAuthority: null, extensions: ["metadataPointer"], program: "spl-token-2022" });
  });
  it("returns null for anything that is not a mint account", () => {
    expect(parseMintAccount({ result: { value: null } })).toBeNull();
    expect(parseMintAccount({})).toBeNull();
    expect(parseMintAccount(null)).toBeNull();
  });
  it("passes a clean mint and fails active authorities or dangerous extensions", () => {
    const clean = { mintAuthority: null, freezeAuthority: null, extensions: ["metadataPointer", "tokenMetadata"], program: "x" };
    expect(evaluateMintInfo(clean).failed).toEqual([]);
    expect(evaluateMintInfo({ ...clean, mintAuthority: "abc" }).failed).toEqual(["MINT_AUTHORITY"]);
    expect(evaluateMintInfo({ ...clean, freezeAuthority: "abc" }).failed).toEqual(["FREEZE_AUTHORITY"]);
    for (const ext of DANGEROUS_EXTENSIONS) {
      expect(evaluateMintInfo({ ...clean, extensions: [ext] }).failed).toEqual(["TOKEN_EXTENSIONS"]);
    }
  });
  it("fails closed when the mint cannot be read", () => {
    expect(evaluateMintInfo(null).failed).toEqual(["MINT_CHECK"]);
  });
  it("returns null on HTTP errors and network failures without leaking the URL", async () => {
    const bad = (async () => new Response("no", { status: 500 })) as typeof fetch;
    expect(await fetchMintInfo("https://rpc.example/?api-key=SECRET", "M", bad)).toBeNull();
    const boom = (async () => { throw new Error("connect failed https://rpc.example/?api-key=SECRET"); }) as typeof fetch;
    expect(await fetchMintInfo("https://rpc.example/?api-key=SECRET", "M", boom)).toBeNull();
  });
});

describe("RugCheck", () => {
  it("summarizes danger and warning risks defensively", () => {
    const s = summarizeRugcheck({ score_normalised: 12, risks: [{ name: "Mutable metadata", level: "warn" }, { name: "Creator sold", level: "danger" }], rugged: false });
    expect(s).toMatchObject({ dangerCount: 1, warnCount: 1, dangerNames: ["Creator sold"], score: 12 });
    expect(s?.topLevelKeys).toContain("risks");
    expect(summarizeRugcheck({})?.dangerCount).toBe(0);
    expect(summarizeRugcheck("nope")).toBeNull();
  });
  it("token bucket enforces the per-minute budget and refills", () => {
    let now = 0;
    const b = new TokenBucket(2, () => now);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, false]);
    now = 30_000;
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });
  it("handles 200, 429, 500 and network errors", async () => {
    const mk = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    const bucket = () => new TokenBucket(100);
    expect((await fetchRugcheck("M", bucket(), undefined, mk(200, { risks: [] }))).status).toBe("ok");
    expect((await fetchRugcheck("M", bucket(), undefined, mk(429))).status).toBe("skipped");
    expect((await fetchRugcheck("M", bucket(), undefined, mk(500))).status).toBe("error");
    const boom = (async () => { throw new Error("x"); }) as typeof fetch;
    expect((await fetchRugcheck("M", bucket(), undefined, boom)).status).toBe("error");
    const spent = new TokenBucket(1, () => 0);
    spent.tryTake();
    expect((await fetchRugcheck("M", spent, undefined, mk(200))).status).toBe("skipped");
  });
  it("sends the API key header only when a key is set", async () => {
    const seen: Array<Record<string, string>> = [];
    const spy = (async (_u: unknown, init?: RequestInit) => { seen.push(init?.headers as Record<string, string>); return new Response("{}"); }) as typeof fetch;
    await fetchRugcheck("M", new TokenBucket(10), undefined, spy);
    await fetchRugcheck("M", new TokenBucket(10), "KEY", spy);
    expect(seen[0]?.["X-API-KEY"]).toBeUndefined();
    expect(seen[1]?.["X-API-KEY"]).toBe("KEY");
  });
});

describe("judge (full pipeline)", () => {
  const cleanMint = mintJson({ mintAuthority: null, freezeAuthority: null, extensions: [] });
  const router = (opts: { mint?: unknown; rug?: () => Response }) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url).includes("rugcheck") ? "rugcheck" : "rpc");
      if (String(url).includes("rugcheck")) return opts.rug ? opts.rug() : new Response(JSON.stringify({ risks: [] }));
      return new Response(JSON.stringify(opts.mint ?? cleanMint));
    }) as typeof fetch;
    return { f, calls };
  };
  const deps = (f: typeof fetch, over: object = {}) => ({ cfg: parseConfig(over), rpcUrl: "https://rpc/?api-key=K", bucket: new TokenBucket(100), fetchFn: f });

  it("stops at the stream stage without making any network call", async () => {
    const { f, calls } = router({});
    const v = await judge({ ...good, top10Pct: 0.9 }, deps(f));
    expect(v.pass).toBe(false);
    expect(v.stage).toBe("stream");
    expect(calls).toEqual([]);
  });
  it("passes a token that clears all three stages", async () => {
    const { f, calls } = router({});
    const v = await judge(good, deps(f));
    expect(v.pass).toBe(true);
    expect(calls).toEqual(["rpc", "rugcheck"]);
  });
  it("rejects at the mint stage and skips RugCheck", async () => {
    const { f, calls } = router({ mint: mintJson({ mintAuthority: "X", freezeAuthority: null, extensions: [] }) });
    const v = await judge(good, deps(f));
    expect(v).toMatchObject({ pass: false, stage: "mint", failed: ["MINT_AUTHORITY"] });
    expect(calls).toEqual(["rpc"]);
  });
  it("rejects on a RugCheck danger", async () => {
    const { f } = router({ rug: () => new Response(JSON.stringify({ risks: [{ name: "Bad", level: "danger" }] })) });
    const v = await judge(good, deps(f));
    expect(v).toMatchObject({ pass: false, stage: "rugcheck", failed: ["RUGCHECK_DANGER"] });
  });
  it("soft-passes when RugCheck is unavailable, unless it is required", async () => {
    const { f } = router({ rug: () => new Response("busy", { status: 429 }) });
    const soft = await judge(good, deps(f));
    expect(soft.pass).toBe(true);
    expect(soft.notes.join()).toMatch(/RugCheck skipped/);
    const hard = await judge(good, deps(f, { safety: { rugcheckRequired: true } }));
    expect(hard).toMatchObject({ pass: false, failed: ["RUGCHECK_AVAILABLE"] });
  });
  it("fails closed when the mint account is unreadable", async () => {
    const { f } = router({ mint: { result: { value: null } } });
    expect((await judge(good, deps(f))).failed).toEqual(["MINT_CHECK"]);
  });
});

describe("launch-time rule", () => {
  const create: CreateEvent = {
    name: "n", symbol: "S", mint: "M", bondingCurve: "B", creator: "C", totalSupply: 1n, virtualTokenReserves: 1n,
    virtualSolReserves: 1n, realTokenReserves: 1n, tokenProgram: "T", mayhem: false, quoteIsSol: true,
  };
  it("lets normal SOL launches through and rejects non-SOL quotes and mayhem mode before any trade data exists", () => {
    expect(launchTimeRule(create, cfg)).toBeNull();
    expect(launchTimeRule({ ...create, quoteIsSol: false }, cfg)).toBe("QUOTE_SOL");
    expect(launchTimeRule({ ...create, mayhem: true }, cfg)).toBe("MAYHEM_MODE");
  });
  it("honors the config switches", () => {
    const off = parseConfig({ safety: { requireSolQuote: false, rejectMayhemMode: false } });
    expect(launchTimeRule({ ...create, quoteIsSol: false, mayhem: true }, off)).toBeNull();
  });
});
