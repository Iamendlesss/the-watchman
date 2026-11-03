import Database from "better-sqlite3";
const db = new Database("data/ledger.sqlite", { readonly: true });

const hoursArg = process.argv[2] ? Number(process.argv[2]) : 3;
const since = Date.now() - hoursArg * 3_600_000;

const rows = db
  .prepare("SELECT reason FROM decisions WHERE action = 'scan_reject' AND ts >= ?")
  .all(since);

const anyFactor = new Map();
const soleFactor = new Map();

for (const { reason } of rows) {
  const rules = reason.split(",").filter(Boolean);
  for (const r of rules) anyFactor.set(r, (anyFactor.get(r) ?? 0) + 1);
  if (rules.length === 1) soleFactor.set(rules[0], (soleFactor.get(rules[0]) ?? 0) + 1);
}

console.log(`${rows.length} rejections in the last ${hoursArg}h.\n`);
console.log("A factor in the rejection:");
for (const [rule, n] of [...anyFactor.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(16)} ${n}  (${((n / rows.length) * 100).toFixed(0)}%)`);
}
console.log("\nThe SOLE reason it failed (loosening just this one would flip it to a pass):");
if (soleFactor.size === 0) console.log("  none -- every rejected coin failed more than one rule at once");
for (const [rule, n] of [...soleFactor.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${rule.padEnd(16)} ${n}  (${((n / rows.length) * 100).toFixed(0)}%)`);
}

// Curve size of coins that failed ONLY on curve size. Final-gate rejects carry their numbers in `details`
// since 2026-10-23; older rows have none and are skipped here.
const curveOnly = db
  .prepare("SELECT reason, details FROM decisions WHERE action = 'scan_reject' AND ts >= ? AND details IS NOT NULL AND reason IN ('CURVE_SOL', 'CURVE_SOL_MAX')")
  .all(since)
  .map((r) => ({ reason: r.reason, sol: JSON.parse(r.details).realSol }))
  .filter((r) => typeof r.sol === "number");
const passes = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE action = 'scan_pass' AND ts >= ?").get(since).n;
// Minutes in the window that have any decision at all: roughly how long the bot was running.
const runMinutes = db
  .prepare("SELECT COUNT(DISTINCT ts / 60000) AS n FROM decisions WHERE ts >= ?")
  .get(since).n;
const runHours = runMinutes / 60;
console.log(`\nCurve size at the final gate (bot running about ${runHours.toFixed(1)}h of the ${hoursArg}h window, ${passes} passed):`);
if (curveOnly.length === 0) {
  console.log("  no data yet -- needs rejects logged since 2026-10-23");
} else {
  const below = curveOnly.filter((r) => r.reason === "CURVE_SOL").map((r) => r.sol);
  const above = curveOnly.filter((r) => r.reason === "CURVE_SOL_MAX").map((r) => r.sol);
  const bands = [[0, 10], [10, 15], [15, 20], [20, 22], [22, 25]];
  console.log("  Failed only because the curve was too small:");
  for (const [lo, hi] of bands) {
    const n = below.filter((x) => x >= lo && x < hi).length;
    console.log(`    ${String(lo).padStart(2)}-${String(hi).padEnd(2)} SOL  ${String(n).padStart(4)}`);
  }
  console.log(`  Failed only because the curve was too big: ${above.length}`);
  console.log("  If the minimum were lowered (stream rules only; mint check and RugCheck can still reject a few):");
  for (const min of [15, 20, 22]) {
    const extra = below.filter((x) => x >= min).length;
    const perHour = runHours > 0 ? (extra / runHours).toFixed(1) : "n/a";
    console.log(`    minRealSol ${min}: ${extra} more coins (${perHour} per hour running)`);
  }
}
db.close();
