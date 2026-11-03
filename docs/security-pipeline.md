# Security Pipeline

Every pull request and every push to `main` runs through [`.github/workflows/security.yml`](../.github/workflows/security.yml). One job, the **Security gate**, passes only when all four checks pass. New advisories can appear when the code has not changed, so the pipeline also runs every Monday.

This pipeline turns part of the [threat model](https://github.com/Iamendlesss/the-watchman-threat-model) into checks that run on every change. It covers threats T-21 and T-22, and it guards controls the review confirmed are working.

```mermaid
flowchart TB
    PR["Pull request or push to main"] --> DEP & SEC & CODE & TEST

    DEP["Dependency audit<br/>npm audit"]
    SEC["Secret scan<br/>Gitleaks, full history"]
    CODE["Code scan<br/>Semgrep and custom rules"]
    TEST["Tests and types<br/>vitest and tsc"]

    DEP & SEC & CODE & TEST --> GATE{"Security gate"}
    GATE -->|"all four pass"| MERGE["Merge allowed"]
    GATE -->|"any check fails"| BLOCK["Merge blocked"]
```

## What blocks a merge

| Check | Blocks on | Reported only |
|---|---|---|
| Dependency audit | High or critical advisories with no valid exception | Moderate, low and info |
| Secret scan | Any secret anywhere in the history of the change | Nothing |
| Code scan | High severity (`ERROR`) findings | Lower severities, listed in the Security tab |
| Tests and types | Any failure | Nothing |

## Custom rules

The rules in [`security/semgrep/watchman-controls.yml`](../security/semgrep/watchman-controls.yml) protect things the threat model found working, so a later change cannot quietly remove them. Each rule has examples in [`security/semgrep/watchman-controls.ts`](../security/semgrep/watchman-controls.ts), and the pipeline tests the rules against those examples before it trusts them.

| Rule | What it stops | Threats |
|---|---|---|
| `watchman-no-signing-library` | Adding a wallet or signing library | T-19, T-25 |
| `watchman-no-trading-key-read` | Code reading the trading key from the environment | T-19 |
| `watchman-no-process-spawn` | Importing modules that can run other programs or code | T-21, T-24 |
| `watchman-no-dynamic-code` | Running a string as code | T-21, T-24 |
| `watchman-sql-from-data` | Building SQL from a value instead of using a placeholder | T-12 |

The test suite guards one more control: `tests/config.test.ts` fails if live mode stops being refused.

## How the pipeline protects itself

- **Pinned tools:** actions are pinned to full commit hashes, the Semgrep image to a digest, and the Gitleaks download to a checked SHA-256. A moved tag cannot change what runs.
- **Least privilege:** the workflow's token is read-only by default, and only the code scan job can write to the Security tab. No job has access to API keys.
- **No stored git credentials:** each checkout discards its token, so later steps cannot push.
- **Fails closed:** if `npm audit` returns anything unusable, or a severity is unknown, the gate blocks. It never assumes a missing result means safe.
- **No new runtime dependencies:** the audit gate uses only Node's standard library. Semgrep and Gitleaks run only in CI.

## Accepting a risk

Sometimes the right call is to accept a finding for a limited time, so the gate supports exceptions in [`security/audit-exceptions.json`](../security/audit-exceptions.json). An exception must name one advisory and one package, give a reason, and carry an expiry date. Once it expires, the build fails again, so nothing can be accepted and forgotten.

## Run it locally

```bash
npm audit --package-lock-only --json > /tmp/audit.json
```

```bash
node scripts/audit-gate.ts /tmp/audit.json security/audit-exceptions.json
```
