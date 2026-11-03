import { describe, expect, it } from "vitest";
import { backfillGap } from "../src/scanner/backfill";

type Call = { method: string; params: unknown[] };
function fakeRpc(handlers: Record<string, (params: unknown[]) => unknown>) {
  const calls: Call[] = [];
  const f = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    const h = handlers[body.method];
    if (!h) return new Response(JSON.stringify({ result: null }));
    const r = h(body.params);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify({ result: r }));
  }) as typeof fetch;
  return { f, calls };
}
const tx = (slot: number, logs: string[], err: unknown = null) => ({ slot, meta: { err, logMessages: logs } });
const base = { rpcUrl: "https://rpc/?api-key=K", bondingCurve: "CURVE", createSignature: "CREATE", maxTxs: 30 };

describe("backfillGap", () => {
  it("returns the gap trades oldest first, skipping failed and already-seen transactions", async () => {
    const { f, calls } = fakeRpc({
      // newest first, as the real API does
      getSignaturesForAddress: () => [
        { signature: "s3", slot: 103, err: null },
        { signature: "sSeen", slot: 102, err: null },
        { signature: "sFail", slot: 102, err: { InstructionError: [0, "x"] } },
        { signature: "s1", slot: 101, err: null },
      ],
      getTransaction: (p) => tx(p[0] === "s1" ? 101 : 103, [`logs of ${p[0]}`]),
    });
    const r = await backfillGap({ ...base, beforeSignature: "FIRSTLIVE", seen: new Set(["sSeen"]), fetchFn: f });
    expect(r.txs.map((t) => t.signature)).toEqual(["s1", "s3"]);
    expect(r.txs[0]).toEqual({ signature: "s1", slot: 101, logs: ["logs of s1"] });
    expect(r.calls).toBe(3); // 1 signature lookup + 2 transactions
    expect(calls[0]).toEqual({
      method: "getSignaturesForAddress",
      params: ["CURVE", { until: "CREATE", before: "FIRSTLIVE", limit: 30, commitment: "confirmed" }],
    });
  });

  it("omits `before` when no live trade was ever seen", async () => {
    const { f, calls } = fakeRpc({ getSignaturesForAddress: () => [] });
    const r = await backfillGap({ ...base, seen: new Set(), fetchFn: f });
    expect(r).toEqual({ txs: [], calls: 1 });
    expect((calls[0]!.params[1] as Record<string, unknown>).before).toBeUndefined();
  });

  it("does nothing without a create signature or with a zero budget", async () => {
    const { f, calls } = fakeRpc({});
    expect(await backfillGap({ ...base, createSignature: "", seen: new Set(), fetchFn: f })).toEqual({ txs: [], calls: 0 });
    expect(await backfillGap({ ...base, maxTxs: 0, seen: new Set(), fetchFn: f })).toEqual({ txs: [], calls: 0 });
    expect(calls).toHaveLength(0);
  });

  it("skips transactions the node cannot return, and never throws", async () => {
    const { f } = fakeRpc({
      getSignaturesForAddress: () => [{ signature: "a", slot: 1, err: null }, { signature: "b", slot: 2, err: null }, { signature: "c", slot: 3, err: null }],
      getTransaction: (p) => (p[0] === "a" ? null : p[0] === "b" ? new Error("boom") : tx(3, ["ok"])),
    });
    const r = await backfillGap({ ...base, seen: new Set(), fetchFn: f });
    expect(r.txs.map((t) => t.signature)).toEqual(["c"]);
    const dead = (async () => { throw new Error("network down"); }) as typeof fetch;
    expect(await backfillGap({ ...base, seen: new Set(), fetchFn: dead })).toEqual({ txs: [], calls: 1 });
  });
});
