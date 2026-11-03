import { describe, expect, it } from "vitest";
import { evaluateGate, readFindings, type AuditException } from "../scripts/audit-gate";

const NOW = Date.parse("2026-11-03T00:00:00Z");

const advisory = (severity: string, id = "GHSA-aaaa-bbbb-cccc") => ({
  title: `A ${severity} problem`,
  url: `https://github.com/advisories/${id}`,
  severity,
});

const report = (vulnerabilities: Record<string, { via: unknown[] }>) => ({
  vulnerabilities,
  metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
});

const exception = (over: Partial<AuditException> = {}): AuditException => ({
  advisory: "GHSA-aaaa-bbbb-cccc",
  package: "zod",
  reason: "Only reads a local config file.",
  approvedOn: "2026-11-03",
  expires: "2027-02-01",
  ...over,
});

describe("audit gate", () => {
  it("passes a clean report", () => {
    const r = evaluateGate(report({}), [], NOW);
    expect(r.ok).toBe(true);
    expect(r.blocked).toEqual([]);
  });

  it.each(["high", "critical"])("blocks a %s finding", (severity) => {
    const r = evaluateGate(report({ zod: { via: [advisory(severity)] } }), [], NOW);
    expect(r.ok).toBe(false);
    expect(r.blocked.map((f) => f.package)).toEqual(["zod"]);
  });

  it.each(["info", "low", "moderate"])("only reports a %s finding", (severity) => {
    const r = evaluateGate(report({ zod: { via: [advisory(severity)] } }), [], NOW);
    expect(r.ok).toBe(true);
    expect(r.reportOnly).toHaveLength(1);
  });

  it("blocks a severity it does not recognize", () => {
    expect(evaluateGate(report({ zod: { via: [advisory("catastrophic")] } }), [], NOW).ok).toBe(false);
  });

  it("accepts a finding with a matching exception that has not expired", () => {
    const r = evaluateGate(report({ zod: { via: [advisory("high")] } }), [exception()], NOW);
    expect(r.ok).toBe(true);
    expect(r.accepted[0]?.expires).toBe("2027-02-01");
  });

  it("does not let an exception cover another package or advisory", () => {
    const vulns = report({ zod: { via: [advisory("high")] } });
    expect(evaluateGate(vulns, [exception({ package: "vite" })], NOW).ok).toBe(false);
    expect(evaluateGate(vulns, [exception({ advisory: "GHSA-xxxx-yyyy-zzzz" })], NOW).ok).toBe(false);
  });

  it.each([
    ["has expired", { expires: "2026-11-02" }],
    ["has an unreadable date", { expires: "soon" }],
    ["gives no reason", { reason: "  " }],
  ])("blocks when the exception %s", (_name, over) => {
    expect(evaluateGate(report({ zod: { via: [advisory("high")] } }), [exception(over)], NOW).ok).toBe(false);
  });

  it("lists exceptions that no longer match anything", () => {
    const r = evaluateGate(report({}), [exception()], NOW);
    expect(r.ok).toBe(true);
    expect(r.unusedExceptions).toHaveLength(1);
  });

  it.each([
    ["nothing", null],
    ["an empty object", {}],
    ["an npm error", { error: { code: "ENOTFOUND", summary: "registry unreachable" } }],
    ["a total with no advisories", { vulnerabilities: { zod: { via: ["other"] } }, metadata: { vulnerabilities: { total: 1 } } }],
  ])("fails closed when the report is %s", (_name, bad) => {
    const r = evaluateGate(bad, [], NOW);
    expect(r.ok).toBe(false);
    expect(r.problem).toBeTruthy();
  });

  it("follows a package to its advisory and ignores pointers to other packages", () => {
    const found = readFindings(report({ vitest: { via: ["@vitest/mocker"] }, "@vitest/mocker": { via: [advisory("moderate")] } }));
    expect(found?.map((f) => f.package)).toEqual(["@vitest/mocker"]);
  });
});
