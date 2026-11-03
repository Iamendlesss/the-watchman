import type { Check } from "./gate";

export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: string[];
  program: string | null;
}

/** Token-2022 extensions that can take money or block selling. Anything not on this list is logged, not blocked. */
export const DANGEROUS_EXTENSIONS = [
  "transferFeeConfig",
  "permanentDelegate",
  "nonTransferable",
  "transferHook",
  "defaultAccountState",
  "pausableConfig",
];

/** Read the fields we need out of a `getAccountInfo` jsonParsed response. Returns null if the shape is unexpected. */
export function parseMintAccount(json: unknown): MintInfo | null {
  const value = (json as { result?: { value?: unknown } } | null)?.result?.value as
    | { data?: { program?: string; parsed?: { type?: string; info?: Record<string, unknown> } } }
    | null
    | undefined;
  const parsed = value?.data?.parsed;
  if (!parsed || parsed.type !== "mint" || !parsed.info) return null;
  const info = parsed.info;
  const exts = Array.isArray(info.extensions)
    ? (info.extensions as { extension?: unknown }[])
        .map((e) => (typeof e.extension === "string" ? e.extension : ""))
        .filter(Boolean)
    : [];
  return {
    mintAuthority: typeof info.mintAuthority === "string" ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === "string" ? info.freezeAuthority : null,
    extensions: exts,
    program: value?.data?.program ?? null,
  };
}

export type FetchFn = typeof fetch;

/** One `getAccountInfo` call. The URL contains the API key, so errors never include it. */
export async function fetchMintInfo(rpcUrl: string, mint: string, fetchFn: FetchFn = fetch): Promise<MintInfo | null> {
  try {
    const res = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [mint, { encoding: "jsonParsed", commitment: "confirmed" }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return parseMintAccount(await res.json());
  } catch {
    return null;
  }
}

export function evaluateMintInfo(info: MintInfo | null): { checks: Check[]; failed: string[] } {
  if (!info) {
    const checks = [{ rule: "MINT_CHECK", passed: false, value: "unavailable", limit: "readable mint account" }];
    return { checks, failed: ["MINT_CHECK"] };
  }
  const bad = info.extensions.filter((e) => DANGEROUS_EXTENSIONS.includes(e));
  const checks: Check[] = [
    {
      rule: "MINT_AUTHORITY",
      passed: info.mintAuthority === null,
      value: info.mintAuthority === null ? "revoked" : "ACTIVE",
      limit: "revoked",
    },
    {
      rule: "FREEZE_AUTHORITY",
      passed: info.freezeAuthority === null,
      value: info.freezeAuthority === null ? "none" : "ACTIVE",
      limit: "none",
    },
    {
      rule: "TOKEN_EXTENSIONS",
      passed: bad.length === 0,
      value: bad.length ? bad.join(",") : info.extensions.length ? info.extensions.join(",") : "none",
      limit: "no fee/delegate/hook extensions",
    },
  ];
  return { checks, failed: checks.filter((c) => !c.passed).map((c) => c.rule) };
}
