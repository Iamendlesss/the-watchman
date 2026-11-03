import type { Config } from "../config";
import type { Snapshot } from "../scanner/tracker";
import { evaluateStreamGate, type Check } from "./gate";
import { evaluateMintInfo, fetchMintInfo, type FetchFn, type MintInfo } from "./mintCheck";
import { fetchRugcheck, type RugcheckSummary, type TokenBucket } from "./rugcheck";

export interface PipelineDeps {
  cfg: Config;
  /** Full Helius RPC URL including the API key. Never printed. */
  rpcUrl: string;
  bucket: TokenBucket;
  rugcheckKey?: string;
  fetchFn?: FetchFn;
}

export interface Verdict {
  pass: boolean;
  /** The stage that decided the outcome. */
  stage: "stream" | "mint" | "rugcheck" | "all";
  failed: string[];
  checks: Check[];
  notes: string[];
  mintInfo?: MintInfo | null;
  rugcheck?: RugcheckSummary;
}

/**
 * The full safety gate. Cheap checks that need only the launch stream run first; the RPC mint check and the
 * rate-limited RugCheck lookup run only for tokens that survived the earlier stage.
 */
export async function judge(snapshot: Snapshot, d: PipelineDeps): Promise<Verdict> {
  const stream = evaluateStreamGate(snapshot, d.cfg);
  const checks = [...stream.checks];
  const notes: string[] = [];
  if (!stream.pass) return { pass: false, stage: "stream", failed: stream.failed, checks, notes };

  let mintInfo: MintInfo | null | undefined;
  if (d.cfg.safety.requireMintCheck) {
    mintInfo = await fetchMintInfo(d.rpcUrl, snapshot.mint, d.fetchFn);
    const m = evaluateMintInfo(mintInfo);
    checks.push(...m.checks);
    if (m.failed.length) return { pass: false, stage: "mint", failed: m.failed, checks, notes, mintInfo };
  }

  if (d.cfg.safety.useRugcheck) {
    const out = await fetchRugcheck(snapshot.mint, d.bucket, d.rugcheckKey, d.fetchFn);
    if (out.status === "ok") {
      const bad = out.summary.dangerCount > 0;
      checks.push({
        rule: "RUGCHECK_DANGER",
        passed: !bad,
        value: bad ? out.summary.dangerNames.join(", ") : "none",
        limit: "no danger-level risks",
      });
      if (bad) {
        return { pass: false, stage: "rugcheck", failed: ["RUGCHECK_DANGER"], checks, notes, mintInfo, rugcheck: out.summary };
      }
      return { pass: true, stage: "all", failed: [], checks, notes, mintInfo, rugcheck: out.summary };
    }
    if (d.cfg.safety.rugcheckRequired) {
      checks.push({ rule: "RUGCHECK_AVAILABLE", passed: false, value: out.reason, limit: "report available" });
      return { pass: false, stage: "rugcheck", failed: ["RUGCHECK_AVAILABLE"], checks, notes, mintInfo };
    }
    notes.push(`RugCheck ${out.status}: ${out.reason}`);
  }
  return { pass: true, stage: "all", failed: [], checks, notes, mintInfo };
}
