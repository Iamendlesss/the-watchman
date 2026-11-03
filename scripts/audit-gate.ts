import fs from "node:fs";
import { pathToFileURL } from "node:url";

const RANK: Record<string, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
/** Findings at or above this severity block the merge. Anything lower is reported only. */
const BLOCK_RANK = RANK.high!;

export interface AuditException {
  advisory: string;
  package: string;
  reason: string;
  approvedOn: string;
  expires: string;
}

export interface Finding {
  advisory: string;
  package: string;
  severity: string;
  title: string;
}

export interface GateResult {
  ok: boolean;
  /** Set when the audit report itself could not be trusted. */
  problem?: string;
  blocked: Finding[];
  accepted: (Finding & { expires: string })[];
  reportOnly: Finding[];
  unusedExceptions: AuditException[];
}

interface AuditReport {
  vulnerabilities?: Record<string, { via?: unknown[] }>;
  metadata?: { vulnerabilities?: { total?: number } };
}

/** The advisories in an `npm audit --json` report, or null if it is not a usable report. */
export function readFindings(report: unknown): Finding[] | null {
  const r = report as AuditReport | null;
  const total = r?.metadata?.vulnerabilities?.total;
  if (!r?.vulnerabilities || typeof r.vulnerabilities !== "object" || typeof total !== "number") return null;
  const seen = new Map<string, Finding>();
  for (const [pkg, vuln] of Object.entries(r.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== "object" || via === null) continue; // a string only points at another package
      const v = via as { url?: unknown; severity?: unknown; title?: unknown };
      const url = String(v.url ?? "");
      const advisory = url.split("/").pop() || `unknown-${String(v.title ?? "advisory")}`;
      seen.set(`${advisory} ${pkg}`, { advisory, package: pkg, severity: String(v.severity ?? "unknown"), title: String(v.title ?? "") });
    }
  }
  if (total > 0 && seen.size === 0) return null; // npm says something is wrong but names nothing
  return [...seen.values()];
}

function validException(e: AuditException, nowMs: number): boolean {
  const expires = Date.parse(e.expires);
  return Boolean(e.reason?.trim()) && Number.isFinite(expires) && expires >= nowMs;
}

/** Fails closed: an unreadable report, an unknown severity or an expired exception all block. */
export function evaluateGate(report: unknown, exceptions: AuditException[], nowMs: number): GateResult {
  const result: GateResult = { ok: false, blocked: [], accepted: [], reportOnly: [], unusedExceptions: [] };
  const findings = readFindings(report);
  if (!findings) {
    result.problem = "npm audit did not produce a usable report, so the dependencies could not be checked.";
    return result;
  }
  const used = new Set<AuditException>();
  for (const f of findings) {
    if ((RANK[f.severity] ?? RANK.critical!) < BLOCK_RANK) {
      result.reportOnly.push(f);
      continue;
    }
    const match = exceptions.find((e) => e.advisory === f.advisory && e.package === f.package);
    if (match) used.add(match);
    if (match && validException(match, nowMs)) result.accepted.push({ ...f, expires: match.expires });
    else result.blocked.push(f);
  }
  result.unusedExceptions = exceptions.filter((e) => !used.has(e));
  result.ok = result.blocked.length === 0;
  return result;
}

const line = (f: Finding) => `${f.severity.padEnd(8)} ${f.package.padEnd(20)} ${f.advisory}  ${f.title}`;

function main(auditPath: string, exceptionsPath: string): number {
  let report: unknown = null;
  let exceptions: AuditException[] = [];
  try {
    report = JSON.parse(fs.readFileSync(auditPath, "utf8"));
    exceptions = (JSON.parse(fs.readFileSync(exceptionsPath, "utf8")) as { exceptions: AuditException[] }).exceptions;
  } catch (e) {
    console.error(`Could not read the audit inputs: ${(e as Error).message}`);
    return 1;
  }
  const r = evaluateGate(report, exceptions, Date.now());
  if (r.problem) console.error(r.problem);
  const section = (title: string, rows: string[]) => {
    if (rows.length) console.log(`\n${title}\n${rows.map((x) => `  ${x}`).join("\n")}`);
  };
  section("BLOCKED (high or critical, with no valid exception):", r.blocked.map(line));
  section("Accepted by a dated exception:", r.accepted.map((f) => `${line(f)}  (expires ${f.expires})`));
  section("Reported only (below high):", r.reportOnly.map(line));
  section("Exceptions that no longer match anything, remove these:", r.unusedExceptions.map((e) => `${e.package} ${e.advisory}`));
  console.log(r.ok ? "\nDependency audit passed." : "\nDependency audit FAILED.");
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [auditPath, exceptionsPath] = process.argv.slice(2);
  if (!auditPath || !exceptionsPath) {
    console.error("Usage: node scripts/audit-gate.ts <audit.json> <exceptions.json>");
    process.exit(1);
  }
  process.exit(main(auditPath, exceptionsPath));
}
