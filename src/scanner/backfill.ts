import type { FetchFn } from "../safety/mintCheck";

export interface RawTx {
  signature: string;
  slot: number;
  logs: string[];
}

export interface BackfillOptions {
  rpcUrl: string;
  bondingCurve: string;
  /** Signature of the create transaction; the search stops there. */
  createSignature: string;
  /** First signature the live subscription delivered; the search starts just before it. */
  beforeSignature?: string;
  maxTxs: number;
  /** Signatures already processed; they are skipped. */
  seen: Set<string>;
  fetchFn?: FetchFn;
}

async function rpc(url: string, method: string, params: unknown[], fetchFn: FetchFn): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown };
  return json.result;
}

/**
 * Fetch the trades that landed between a launch and the moment our per-coin subscription became active
 * (usually the first slot or two, where bundled buys live). Returns oldest first. Never throws: on any
 * error it returns whatever it managed to fetch, and the number of RPC calls it made.
 */
export async function backfillGap(o: BackfillOptions): Promise<{ txs: RawTx[]; calls: number }> {
  const fetchFn = o.fetchFn ?? fetch;
  const txs: RawTx[] = [];
  let calls = 0;
  if (!o.createSignature || o.maxTxs <= 0) return { txs, calls };
  try {
    calls++;
    const sigs = (await rpc(
      o.rpcUrl,
      "getSignaturesForAddress",
      [
        o.bondingCurve,
        {
          until: o.createSignature,
          ...(o.beforeSignature ? { before: o.beforeSignature } : {}),
          limit: o.maxTxs,
          commitment: "confirmed",
        },
      ],
      fetchFn,
    )) as { signature: string; slot?: number; err: unknown }[] | null;
    const wanted = (sigs ?? [])
      .filter((s) => !s.err && s.signature !== o.createSignature && !o.seen.has(s.signature))
      .reverse(); // the API returns newest first
    for (let i = 0; i < wanted.length; i += 3) {
      const chunk = wanted.slice(i, i + 3);
      calls += chunk.length;
      const got = await Promise.all(
        chunk.map(async (s) => {
          try {
            const r = (await rpc(
              o.rpcUrl,
              "getTransaction",
              [s.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }],
              fetchFn,
            )) as { slot?: number; meta?: { err?: unknown; logMessages?: string[] } } | null;
            if (!r?.meta || r.meta.err || !Array.isArray(r.meta.logMessages)) return null;
            return { signature: s.signature, slot: r.slot ?? s.slot ?? 0, logs: r.meta.logMessages } as RawTx;
          } catch {
            return null;
          }
        }),
      );
      for (const g of got) if (g) txs.push(g);
    }
  } catch {
    /* fall through with what we have */
  }
  return { txs, calls };
}
