import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Strategy = "snipe" | "momentum";

/** One executed (or simulated) trade leg. All SOL amounts are positive numbers. */
export interface Fill {
  side: "buy" | "sell";
  tokens: number;
  /** Average execution price in SOL per token. */
  priceSol: number;
  /** Gross SOL moved: spent on a buy, received on a sell (before fees). */
  solAmount: number;
  /** Network fee + priority fee + Sender tip for this leg. */
  feesSol: number;
  /** Token-account rent deposit: positive when paid, negative when returned. Not counted as P&L. */
  rentSol: number;
  /** Value shortfall versus the mid price, as a fraction (0.02 = 2%). */
  slippagePct: number;
}

export interface PositionRow {
  id: number;
  mint: string;
  symbol: string;
  strategy: Strategy;
  status: "open" | "closed";
  opened_at: number;
  closed_at: number | null;
  entry_price_sol: number;
  entry_size_sol: number;
  tokens: number;
  tokens_initial: number;
  cost_basis_sol: number;
  fees_paid_sol: number;
  realized_pnl_sol: number;
  peak_price_sol: number;
  recovered_initial: number;
  exit_reason: string | null;
  gate_snapshot: string | null;
  last_price_sol: number | null;
}

export interface Summary {
  openPositions: number;
  closedPositions: number;
  wins: number;
  losses: number;
  realizedPnlSol: number;
  feesPaidSol: number;
  avgWinSol: number;
  avgLossSol: number;
  byStrategy: Record<string, { closed: number; wins: number; realizedPnlSol: number }>;
}

const EPS = 1e-9;

export class Ledger {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        entry_price_sol REAL NOT NULL,
        entry_size_sol REAL NOT NULL,
        tokens REAL NOT NULL,
        tokens_initial REAL NOT NULL,
        cost_basis_sol REAL NOT NULL,
        fees_paid_sol REAL NOT NULL DEFAULT 0,
        realized_pnl_sol REAL NOT NULL DEFAULT 0,
        peak_price_sol REAL NOT NULL,
        recovered_initial INTEGER NOT NULL DEFAULT 0,
        exit_reason TEXT,
        gate_snapshot TEXT
      );
      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER NOT NULL REFERENCES positions(id),
        ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        tokens REAL NOT NULL,
        price_sol REAL NOT NULL,
        sol_amount REAL NOT NULL,
        fees_sol REAL NOT NULL,
        rent_sol REAL NOT NULL DEFAULT 0,
        slippage_pct REAL NOT NULL,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        mint TEXT,
        strategy TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT
      );
      CREATE TABLE IF NOT EXISTS day_equity (
        day TEXT PRIMARY KEY,
        equity_sol REAL NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_usage (
        day TEXT PRIMARY KEY,
        credits REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS halts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        reason TEXT NOT NULL,
        cleared_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS equity_peak (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        peak_sol REAL NOT NULL,
        set_at INTEGER NOT NULL,
        reset_at INTEGER NOT NULL
      );
    `);
    // Columns added after the first release: older ledgers are upgraded in place.
    const cols = (this.db.prepare("PRAGMA table_info(positions)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("last_price_sol")) this.db.exec("ALTER TABLE positions ADD COLUMN last_price_sol REAL");
    // The heartbeat and daily report count decisions by time while the bot is trading, so that must stay fast.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_decisions_ts ON decisions(ts)");
  }

  // ---- decisions (every accept and every rejection is logged) ----

  logDecision(d: {
    ts: number;
    mint?: string;
    strategy?: Strategy;
    action: string;
    reason: string;
    details?: unknown;
  }): void {
    this.db
      .prepare(
        "INSERT INTO decisions (ts, mint, strategy, action, reason, details) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        d.ts,
        d.mint ?? null,
        d.strategy ?? null,
        d.action,
        d.reason,
        d.details === undefined ? null : JSON.stringify(d.details),
      );
  }

  /** Decisions in [fromMs, toMs), counted by action and reason. */
  decisionCounts(fromMs: number, toMs: number): { action: string; reason: string; count: number }[] {
    return this.db
      .prepare("SELECT action, reason, COUNT(*) AS count FROM decisions WHERE ts >= ? AND ts < ? GROUP BY action, reason")
      .all(fromMs, toMs) as { action: string; reason: string; count: number }[];
  }

  /** Minutes in [fromMs, toMs) with at least one decision: roughly how long the bot was running. */
  activeMinutes(fromMs: number, toMs: number): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT ts / 60000) AS n FROM decisions WHERE ts >= ? AND ts < ?").get(fromMs, toMs) as { n: number }).n;
  }

  hasDecision(action: string, reason: string): boolean {
    return this.db.prepare("SELECT 1 FROM decisions WHERE action = ? AND reason = ? LIMIT 1").get(action, reason) !== undefined;
  }

  countDecisions(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n;
  }

  // ---- positions and fills ----

  openPosition(p: {
    mint: string;
    symbol: string;
    strategy: Strategy;
    ts: number;
    fill: Fill;
    gateSnapshot?: unknown;
  }): number {
    if (p.fill.side !== "buy") throw new Error("openPosition needs a buy fill");
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare(
          `INSERT INTO positions
           (mint, symbol, strategy, status, opened_at, entry_price_sol, entry_size_sol, tokens, tokens_initial,
            cost_basis_sol, fees_paid_sol, peak_price_sol, gate_snapshot)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.mint,
          p.symbol,
          p.strategy,
          p.ts,
          p.fill.priceSol,
          p.fill.solAmount,
          p.fill.tokens,
          p.fill.tokens,
          p.fill.solAmount + p.fill.feesSol,
          p.fill.feesSol,
          p.fill.priceSol,
          p.gateSnapshot === undefined ? null : JSON.stringify(p.gateSnapshot),
        );
      const id = Number(res.lastInsertRowid);
      this.insertFill(id, p.ts, p.fill, "entry");
      return id;
    });
    return tx();
  }

  private insertFill(positionId: number, ts: number, f: Fill, reason: string): void {
    this.db
      .prepare(
        `INSERT INTO fills (position_id, ts, side, tokens, price_sol, sol_amount, fees_sol, rent_sol, slippage_pct, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(positionId, ts, f.side, f.tokens, f.priceSol, f.solAmount, f.feesSol, f.rentSol, f.slippagePct, reason);
  }

  /** Record a sell. Realized P&L uses the cost basis of the tokens sold (fees included). */
  recordSell(
    positionId: number,
    ts: number,
    fill: Fill,
    reason: string,
    opts: { markRecoveredInitial?: boolean } = {},
  ): { closed: boolean; realizedDeltaSol: number } {
    if (fill.side !== "sell") throw new Error("recordSell needs a sell fill");
    const tx = this.db.transaction(() => {
      const pos = this.getPosition(positionId);
      if (!pos) throw new Error(`position ${positionId} not found`);
      if (pos.status !== "open") throw new Error(`position ${positionId} is already closed`);
      if (fill.tokens > pos.tokens * (1 + 1e-6)) {
        throw new Error(`cannot sell ${fill.tokens} tokens; only ${pos.tokens} held`);
      }
      const basisPortion = pos.cost_basis_sol * (fill.tokens / pos.tokens_initial);
      const realizedDelta = fill.solAmount - fill.feesSol - basisPortion;
      const remaining = pos.tokens - fill.tokens;
      const closed = remaining <= pos.tokens_initial * EPS;
      this.insertFill(positionId, ts, fill, reason);
      this.db
        .prepare(
          `UPDATE positions SET tokens = ?, realized_pnl_sol = realized_pnl_sol + ?, fees_paid_sol = fees_paid_sol + ?,
             status = ?, closed_at = ?, exit_reason = ?, recovered_initial = MAX(recovered_initial, ?)
           WHERE id = ?`,
        )
        .run(
          closed ? 0 : remaining,
          realizedDelta,
          fill.feesSol,
          closed ? "closed" : "open",
          closed ? ts : null,
          closed ? reason : null,
          opts.markRecoveredInitial ? 1 : 0,
          positionId,
        );
      return { closed, realizedDeltaSol: realizedDelta };
    });
    return tx();
  }

  setLastPrice(positionId: number, priceSol: number): void {
    this.db.prepare("UPDATE positions SET last_price_sol = ? WHERE id = ?").run(priceSol, positionId);
  }

  /**
   * Closed positions grouped by why they were closed, with both the SOL total and the average return as a
   * percent of cost basis. The percent figure is what actually answers "is this category good or bad" once
   * position sizes have drifted (3% of a shrinking or growing wallet is a different SOL amount each time).
   */
  exitBreakdown(): { reason: string; count: number; pnlSol: number; avgPct: number }[] {
    return this.db
      .prepare(
        `SELECT COALESCE(exit_reason, 'unknown') AS reason, COUNT(*) AS count, SUM(realized_pnl_sol) AS pnlSol,
                AVG(realized_pnl_sol / cost_basis_sol) AS avgPct
         FROM positions WHERE status = 'closed' GROUP BY reason ORDER BY count DESC`,
      )
      .all() as { reason: string; count: number; pnlSol: number; avgPct: number }[];
  }

  /**
   * Same breakdown, but only for positions opened at or after `sinceMs`. Lets you compare "before this config
   * change" against "after it" using the same running ledger, without needing a fresh wallet or a new session.
   */
  exitBreakdownSince(sinceMs: number): { reason: string; count: number; pnlSol: number; avgPct: number }[] {
    return this.db
      .prepare(
        `SELECT COALESCE(exit_reason, 'unknown') AS reason, COUNT(*) AS count, SUM(realized_pnl_sol) AS pnlSol,
                AVG(realized_pnl_sol / cost_basis_sol) AS avgPct
         FROM positions WHERE status = 'closed' AND opened_at >= ? GROUP BY reason ORDER BY count DESC`,
      )
      .all(sinceMs) as { reason: string; count: number; pnlSol: number; avgPct: number }[];
  }

  /** Overall win rate, average win/loss, and expectancy as a percent of cost basis -- the size-independent view. */
  pctSummary(sinceMs?: number): { trades: number; winRatePct: number; avgWinPct: number; avgLossPct: number; expectancyPct: number } | null {
    const rows = this.db
      .prepare(
        `SELECT realized_pnl_sol / cost_basis_sol AS pct FROM positions
         WHERE status = 'closed'${sinceMs !== undefined ? " AND opened_at >= ?" : ""}`,
      )
      .all(...(sinceMs !== undefined ? [sinceMs] : [])) as { pct: number }[];
    if (rows.length === 0) return null;
    const wins = rows.filter((r) => r.pct >= 0).map((r) => r.pct);
    const losses = rows.filter((r) => r.pct < 0).map((r) => r.pct);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      trades: rows.length,
      winRatePct: wins.length / rows.length,
      avgWinPct: avg(wins),
      avgLossPct: avg(losses),
      expectancyPct: avg(rows.map((r) => r.pct)),
    };
  }

  /** Why the risk manager or executor turned entries down (scan verdicts are logged as scan_reject, not counted here). */
  rejectionCounts(): { reason: string; count: number }[] {
    return this.db
      .prepare("SELECT reason, COUNT(*) AS count FROM decisions WHERE action = 'reject' GROUP BY reason ORDER BY count DESC")
      .all() as { reason: string; count: number }[];
  }

  updatePeak(positionId: number, priceSol: number): void {
    this.db
      .prepare("UPDATE positions SET peak_price_sol = MAX(peak_price_sol, ?) WHERE id = ?")
      .run(priceSol, positionId);
  }

  getPosition(id: number): PositionRow | undefined {
    return this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined;
  }

  getOpenPositions(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY id").all() as PositionRow[];
  }

  /** Positions closed in [fromMs, toMs), oldest first. */
  closedBetween(fromMs: number, toMs: number): PositionRow[] {
    return this.db
      .prepare("SELECT * FROM positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ? ORDER BY closed_at")
      .all(fromMs, toMs) as PositionRow[];
  }

  /** The most recently closed positions, newest first. */
  recentClosed(limit: number): PositionRow[] {
    return this.db
      .prepare("SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT ?")
      .all(limit) as PositionRow[];
  }

  countOpenedBetween(fromMs: number, toMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE opened_at >= ? AND opened_at < ?").get(fromMs, toMs) as { n: number }).n;
  }

  // ---- money ----

  /** Cash in SOL: starting balance plus every fill's cash effect, including rent deposits. */
  cashSol(startingSol: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE WHEN side = 'buy' THEN -(sol_amount + fees_sol) ELSE (sol_amount - fees_sol) END - rent_sol
         ), 0) AS net FROM fills`,
      )
      .get() as { net: number };
    return startingSol + row.net;
  }

  /**
   * Equity = cash + rent deposits held + open positions valued at the marks you pass in (SOL per token).
   * Pass conservative marks (what a sell would actually return), not just the mid price.
   * A position without a mark is valued at its entry price.
   */
  equitySol(startingSol: number, marks: Map<string, number> = new Map()): number {
    const cash = this.cashSol(startingSol);
    let held = 0;
    for (const p of this.getOpenPositions()) {
      held += p.tokens * (marks.get(p.mint) ?? p.entry_price_sol);
    }
    const rent = this.db
      .prepare(
        `SELECT COALESCE(SUM(rent_sol), 0) AS r FROM fills
         WHERE position_id IN (SELECT id FROM positions WHERE status = 'open')`,
      )
      .get() as { r: number };
    return cash + held + rent.r;
  }

  /** Equity at the start of the given day. The first call each day stores the value; later calls return it. */
  startOfDayEquity(day: string, currentEquitySol: number, ts: number): number {
    this.db
      .prepare("INSERT OR IGNORE INTO day_equity (day, equity_sol, ts) VALUES (?, ?, ?)")
      .run(day, currentEquitySol, ts);
    return (this.db.prepare("SELECT equity_sol FROM day_equity WHERE day = ?").get(day) as { equity_sol: number })
      .equity_sol;
  }

  // ---- drawdown floor: the high-water mark of equity since the last reset ----

  /**
   * The high-water mark. The first call ever stores `currentEquitySol` as the starting mark, so the floor starts
   * fresh from whenever it was first switched on rather than from an old peak.
   */
  peakEquity(currentEquitySol: number, ts: number): number {
    this.db
      .prepare("INSERT OR IGNORE INTO equity_peak (id, peak_sol, set_at, reset_at) VALUES (1, ?, ?, ?)")
      .run(currentEquitySol, ts, ts);
    return (this.db.prepare("SELECT peak_sol FROM equity_peak WHERE id = 1").get() as { peak_sol: number }).peak_sol;
  }

  /** Raise the mark if `equitySol` is a new high. Never lowers it. */
  raisePeakEquity(equitySol: number, ts: number): void {
    this.db.prepare("UPDATE equity_peak SET peak_sol = ?, set_at = ? WHERE id = 1 AND peak_sol < ?").run(equitySol, ts, equitySol);
  }

  /** Start the mark again from `equitySol` (used when a drawdown halt is cleared). */
  resetPeakEquity(equitySol: number, ts: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO equity_peak (id, peak_sol, set_at, reset_at) VALUES (1, ?, ?, ?)")
      .run(equitySol, ts, ts);
  }

  getPeakEquity(): { peakSol: number; setAt: number; resetAt: number } | null {
    const row = this.db.prepare("SELECT peak_sol, set_at, reset_at FROM equity_peak WHERE id = 1").get() as
      | { peak_sol: number; set_at: number; reset_at: number }
      | undefined;
    return row ? { peakSol: row.peak_sol, setAt: row.set_at, resetAt: row.reset_at } : null;
  }

  // ---- Helius credit accounting (the bot's own count, per UTC day) ----

  addCredits(day: string, credits: number): void {
    this.db
      .prepare("INSERT INTO credit_usage (day, credits) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET credits = credits + excluded.credits")
      .run(day, credits);
  }

  creditsUsed(day: string): number {
    const row = this.db.prepare("SELECT credits FROM credit_usage WHERE day = ?").get(day) as { credits: number } | undefined;
    return row?.credits ?? 0;
  }

  // ---- loss streak ----

  consecutiveLosses(): { count: number; lastLossAt: number | null } {
    const rows = this.db
      .prepare(
        "SELECT realized_pnl_sol AS pnl, closed_at FROM positions WHERE status = 'closed' ORDER BY closed_at DESC, id DESC",
      )
      .all() as { pnl: number; closed_at: number }[];
    let count = 0;
    let lastLossAt: number | null = null;
    for (const r of rows) {
      if (r.pnl < 0) {
        if (count === 0) lastLossAt = r.closed_at;
        count++;
      } else break;
    }
    return { count, lastLossAt };
  }

  // ---- halts (stay in force until you run `npm run resume`) ----

  setHalt(reason: string, ts: number): void {
    if (this.getHalt()) return;
    this.db.prepare("INSERT INTO halts (ts, reason) VALUES (?, ?)").run(ts, reason);
  }

  getHalt(): { reason: string; ts: number } | null {
    const row = this.db
      .prepare("SELECT reason, ts FROM halts WHERE cleared_at IS NULL ORDER BY id DESC LIMIT 1")
      .get() as { reason: string; ts: number } | undefined;
    return row ?? null;
  }

  clearHalt(ts: number): boolean {
    return this.db.prepare("UPDATE halts SET cleared_at = ? WHERE cleared_at IS NULL").run(ts).changes > 0;
  }

  /** Every closed position's outcome plus its raw entry-time gate snapshot, for /src/analyze.ts to bucket. */
  closedPositionsWithSnapshot(): { pnlPct: number; exitReason: string; gateSnapshot: string | null }[] {
    return this.db
      .prepare(
        `SELECT realized_pnl_sol / cost_basis_sol AS pnlPct, COALESCE(exit_reason, 'unknown') AS exitReason, gate_snapshot AS gateSnapshot
         FROM positions WHERE status = 'closed'`,
      )
      .all() as { pnlPct: number; exitReason: string; gateSnapshot: string | null }[];
  }

  // ---- reporting ----

  summary(): Summary {
    const closed = this.db
      .prepare("SELECT strategy, realized_pnl_sol AS pnl, fees_paid_sol AS fees FROM positions WHERE status = 'closed'")
      .all() as { strategy: string; pnl: number; fees: number }[];
    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'").get() as { n: number }).n;
    const openFees = (
      this.db.prepare("SELECT COALESCE(SUM(fees_paid_sol),0) AS f FROM positions WHERE status = 'open'").get() as {
        f: number;
      }
    ).f;
    const wins = closed.filter((c) => c.pnl >= 0);
    const losses = closed.filter((c) => c.pnl < 0);
    const byStrategy: Summary["byStrategy"] = {};
    for (const c of closed) {
      const s = (byStrategy[c.strategy] ??= { closed: 0, wins: 0, realizedPnlSol: 0 });
      s.closed++;
      if (c.pnl >= 0) s.wins++;
      s.realizedPnlSol += c.pnl;
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    return {
      openPositions: open,
      closedPositions: closed.length,
      wins: wins.length,
      losses: losses.length,
      realizedPnlSol: sum(closed.map((c) => c.pnl)),
      feesPaidSol: sum(closed.map((c) => c.fees)) + openFees,
      avgWinSol: wins.length ? sum(wins.map((c) => c.pnl)) / wins.length : 0,
      avgLossSol: losses.length ? sum(losses.map((c) => c.pnl)) / losses.length : 0,
      byStrategy,
    };
  }
}
