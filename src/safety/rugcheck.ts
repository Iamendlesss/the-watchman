import type { FetchFn } from "./mintCheck";

/** Simple token bucket so the scanner never exceeds RugCheck's low unauthenticated limit. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = perMinute;
    this.last = now();
  }
  tryTake(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60_000) * this.perMinute);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface RugcheckSummary {
  dangerCount: number;
  warnCount: number;
  dangerNames: string[];
  score: number | null;
  topLevelKeys: string[];
}

/**
 * Defensive parse of a RugCheck token report. The field names (`risks[].level`, `risks[].name`) come from
 * third-party descriptions of the API and are not yet confirmed against its Swagger page; the scan command
 * prints the top-level keys it sees so the parse can be checked against real responses.
 *
 * A reply without a `risks` list, or with a risk that has no level, returns null so the caller treats it as an
 * error. Reading it as "no risks" would record an unchecked coin as checked, and let it past even when RugCheck
 * is required.
 */
export function summarizeRugcheck(json: unknown): RugcheckSummary | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.risks)) return null;
  const risks = o.risks as Record<string, unknown>[];
  if (!risks.every((r) => r !== null && typeof r === "object" && typeof r.level === "string")) return null;
  const level = (r: Record<string, unknown>) => String(r.level ?? "").toLowerCase();
  const dangers = risks.filter((r) => level(r) === "danger");
  const score = typeof o.score_normalised === "number" ? o.score_normalised : typeof o.score === "number" ? o.score : null;
  return {
    dangerCount: dangers.length,
    warnCount: risks.filter((r) => level(r) === "warn").length,
    dangerNames: dangers.map((r) => String(r.name ?? "unnamed")),
    score,
    topLevelKeys: Object.keys(o).slice(0, 25),
  };
}

export type RugcheckOutcome =
  | { status: "ok"; summary: RugcheckSummary }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

export async function fetchRugcheck(
  mint: string,
  bucket: TokenBucket,
  apiKey: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<RugcheckOutcome> {
  if (!bucket.tryTake()) return { status: "skipped", reason: "rate limit budget used" };
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers["X-API-KEY"] = apiKey;
    const res = await fetchFn(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) return { status: "skipped", reason: "HTTP 429 (rate limited)" };
    if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };
    const summary = summarizeRugcheck(await res.json());
    return summary ? { status: "ok", summary } : { status: "error", reason: "unexpected response shape" };
  } catch (e) {
    return { status: "error", reason: (e as Error).name === "TimeoutError" ? "timeout" : "network error" };
  }
}
