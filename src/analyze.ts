import type { Snapshot } from "./scanner/tracker";

/** One closed position's outcome plus its raw entry snapshot, exactly as stored on the positions row. */
export interface EntryRow {
  pnlPct: number;
  exitReason: string;
  gateSnapshot: string | null;
}

export interface BucketStat {
  label: string;
  count: number;
  winRatePct: number;
  avgPct: number;
  hardStopRatePct: number;
}

export interface FieldBreakdown {
  field: string;
  buckets: BucketStat[];
  /** Trades where this field was missing or not a number (older ledgers, or a non-snapshot entry). */
  skipped: number;
}

interface Edge {
  label: string;
  min: number;
  /** Exclusive, except for the last edge of a field, which is treated as inclusive. */
  max: number;
}

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Bucket edges for each entry-time field worth checking against outcomes. These are starting guesses, not
 * statistically derived -- the point of this tool is to let the data itself show whether a cutoff near one
 * of these edges actually separates good entries from bad ones.
 */
export const FIELD_EDGES: Record<string, Edge[]> = {
  runupMultiple: [
    { label: "<2x", min: -Infinity, max: 2 },
    { label: "2-4x", min: 2, max: 4 },
    { label: "4-8x", min: 4, max: 8 },
    { label: "8x+", min: 8, max: Infinity },
  ],
  top10Pct: [
    { label: "<15%", min: -Infinity, max: 0.15 },
    { label: "15-25%", min: 0.15, max: 0.25 },
    { label: "25-35%", min: 0.25, max: 0.35 },
    { label: "35%+", min: 0.35, max: Infinity },
  ],
  bundledPct: [
    { label: "0%", min: -Infinity, max: 1e-9 },
    { label: "0-5%", min: 1e-9, max: 0.05 },
    { label: "5-15%", min: 0.05, max: 0.15 },
    { label: "15%+", min: 0.15, max: Infinity },
  ],
  uniqueBuyers: [
    { label: "<30", min: -Infinity, max: 30 },
    { label: "30-60", min: 30, max: 60 },
    { label: "60-120", min: 60, max: 120 },
    { label: "120+", min: 120, max: Infinity },
  ],
  realSol: [
    { label: "<10", min: -Infinity, max: 10 },
    { label: "10-25", min: 10, max: 25 },
    { label: "25-50", min: 25, max: 50 },
    { label: "50+", min: 50, max: Infinity },
  ],
};

function bucketField(rows: { value: number; pnlPct: number; isHardStop: boolean }[], edges: Edge[]): BucketStat[] {
  return edges.map((e, i) => {
    const isLast = i === edges.length - 1;
    const inBucket = rows.filter((r) => r.value >= e.min && (isLast ? r.value <= e.max : r.value < e.max));
    const wins = inBucket.filter((r) => r.pnlPct >= 0);
    const hardStops = inBucket.filter((r) => r.isHardStop);
    return {
      label: e.label,
      count: inBucket.length,
      winRatePct: inBucket.length ? wins.length / inBucket.length : 0,
      avgPct: avg(inBucket.map((r) => r.pnlPct)),
      hardStopRatePct: inBucket.length ? hardStops.length / inBucket.length : 0,
    };
  });
}

/**
 * Splits closed trades by each field in FIELD_EDGES and reports win rate, average return, and hard-stop rate
 * per bucket, so a pattern in WHICH entries tend to fail shows up directly instead of being guessed at.
 */
export function analyzeEntries(rows: EntryRow[]): { breakdowns: FieldBreakdown[]; parsed: number; skipped: number } {
  const parsedRows: { snapshot: Partial<Snapshot>; pnlPct: number; isHardStop: boolean }[] = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.gateSnapshot) {
      skipped++;
      continue;
    }
    try {
      const snapshot = JSON.parse(r.gateSnapshot) as Partial<Snapshot>;
      parsedRows.push({ snapshot, pnlPct: r.pnlPct, isHardStop: r.exitReason === "hard stop-loss" });
    } catch {
      skipped++;
    }
  }

  const breakdowns: FieldBreakdown[] = Object.entries(FIELD_EDGES).map(([field, edges]) => {
    const withValue = parsedRows
      .map((r) => ({ v: (r.snapshot as Record<string, unknown>)[field], r }))
      .filter((x): x is { v: number; r: (typeof parsedRows)[number] } => typeof x.v === "number");
    const vals = withValue.map(({ v, r }) => ({ value: v, pnlPct: r.pnlPct, isHardStop: r.isHardStop }));
    return { field, buckets: bucketField(vals, edges), skipped: parsedRows.length - vals.length };
  });

  return { breakdowns, parsed: parsedRows.length, skipped };
}
