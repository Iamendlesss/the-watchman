import type { Config } from "../config";
import { utcDay } from "../engine";
import type { Ledger, PositionRow } from "../ledger";
import type { Snapshot } from "../scanner/tracker";
import { buildDailyReport } from "./daily";
import type { Delivered } from "./discord";
import * as m from "./messages";

export interface Sender {
  readonly enabled: boolean;
  send(text: string, done?: Delivered): void;
}

/** What the paper trader reports as it trades. */
export interface TradeAlerts {
  opened(pos: PositionRow, snap: Snapshot): void;
  partial(pos: PositionRow, reason: string, realizedSol: number): void;
  closed(pos: PositionRow): void;
  /** The risk manager turned an entry down. `reasons` are its "CODE: message" lines. */
  blocked(reasons: string[], now: number): void;
  /** Equity just fell through the drawdown floor and trading is now halted. */
  floorHit(equity: number, peak: number, now: number): void;
}

export const NO_ALERTS: TradeAlerts = { opened() {}, partial() {}, closed() {}, blocked() {}, floorHit() {} };

// Routine blocks (COST_CAP, MAX_POSITIONS) happen all the time and are left to the daily report.
const WORTH_TELLING = new Set(["HALTED", "DAILY_LOSS", "DRAWDOWN", "STOP_FILE", "LOSS_PAUSE", "INSUFFICIENT_CASH"]);
// A halt starts as DAILY_LOSS or DRAWDOWN, then shows as HALTED on every later entry: one alert covers all three.
const HALT_CODES = new Set(["HALTED", "DAILY_LOSS", "DRAWDOWN"]);
const REPEAT_MS = 60 * 60_000;
const LAUNCH_TIME = new Set(["QUOTE_SOL", "MAYHEM_MODE", "EARLY_NO_TRACTION"]);
const REPORT_RETRY_MS = 10 * 60_000;

/**
 * Turns paper-trading events into Discord messages: trades, risk halts and pauses (each at most once an hour),
 * stream outages that last, a heartbeat, and the daily report (once per UTC day, remembered in the ledger so a
 * restart doesn't send it twice). The report counts as sent only once Discord has confirmed it, and is retried
 * 10 minutes after a failed attempt.
 */
export class PaperAlerts implements TradeAlerts {
  private lastHeartbeat: number;
  private readonly lastBlock = new Map<string, number>();
  private downSince: number | null = null;
  private downAlerted = false;
  private reportCheckedFor: string | null = null;
  private reportPending = false;
  private reportRetryAt = -Infinity;

  constructor(
    private readonly out: Sender,
    private readonly cfg: Config,
    private readonly ledger: Ledger,
    private readonly startedAt: number,
  ) {
    this.lastHeartbeat = startedAt;
  }

  get enabled(): boolean {
    return this.out.enabled;
  }

  started(equity: number, orphansClosed: number, peak: number, halt: string | null): void {
    this.out.send(m.started(this.cfg, equity, orphansClosed, peak, halt));
  }

  floorHit(equity: number, peak: number, now: number): void {
    this.lastBlock.set("HALTED", now); // the floor message says it all; no "halted" reminder for an hour
    this.out.send(m.floorHit(equity, peak, this.cfg));
  }

  stopped(now: number, opened: number, closed: number, equity: number): void {
    this.out.send(m.stopped({ ranMs: now - this.startedAt, opened, closed, equity, startingSol: this.cfg.wallet.startingSol }));
  }

  opened(pos: PositionRow, snap: Snapshot): void {
    this.out.send(m.opened(pos, snap));
  }

  partial(pos: PositionRow, reason: string, realizedSol: number): void {
    this.out.send(m.partial(pos, reason, realizedSol));
  }

  closed(pos: PositionRow): void {
    this.out.send(m.closed(pos));
  }

  blocked(reasons: string[], now: number): void {
    for (const line of reasons) {
      const i = line.indexOf(":");
      const code = i > 0 ? line.slice(0, i) : line;
      if (!WORTH_TELLING.has(code)) continue;
      const key = HALT_CODES.has(code) ? "HALTED" : code;
      if (now - (this.lastBlock.get(key) ?? -Infinity) < REPEAT_MS) continue;
      this.lastBlock.set(key, now);
      this.out.send(m.riskBlocked(code, i > 0 ? line.slice(i + 1).trim() : line));
    }
  }

  /** From the stream: `down` is true when no connection is open, false when one is back. */
  streamChange(down: boolean, now: number): void {
    if (down) {
      this.downSince ??= now;
      return;
    }
    if (this.downAlerted && this.downSince !== null) this.out.send(m.streamBack(now - this.downSince));
    this.downSince = null;
    this.downAlerted = false;
  }

  /** Called on every scan tick. Cheap unless something is due. */
  tick(now: number, equity: () => number): void {
    if (!this.out.enabled) return;
    const a = this.cfg.alerts;
    if (this.downSince !== null && !this.downAlerted && now - this.downSince >= a.streamDownAlertSeconds * 1000) {
      this.downAlerted = true;
      this.out.send(m.streamDown(now - this.downSince, this.ledger.getOpenPositions().length));
    }
    if (a.heartbeatHours > 0 && now - this.lastHeartbeat >= a.heartbeatHours * 3_600_000) {
      this.out.send(this.heartbeat(now, equity()));
      this.lastHeartbeat = now;
    }
    if (new Date(now).getUTCHours() >= a.dailyReportHourUtc) {
      const day = utcDay(now - 86_400_000);
      if (this.reportCheckedFor !== day && !this.reportPending && now >= this.reportRetryAt) {
        const marker = `daily report ${day}`;
        if (this.ledger.hasDecision("alert", marker)) {
          this.reportCheckedFor = day;
        } else {
          this.reportPending = true;
          this.out.send(buildDailyReport(this.ledger, this.cfg, day, equity()), (ok) => {
            this.reportPending = false;
            if (!ok) {
              this.reportRetryAt = now + REPORT_RETRY_MS;
              return;
            }
            this.reportCheckedFor = day;
            this.ledger.logDecision({ ts: now, action: "alert", reason: marker });
          });
        }
      }
    }
  }

  private heartbeat(now: number, equity: number): string {
    let launches = 0;
    let judged = 0;
    let passed = 0;
    for (const c of this.ledger.decisionCounts(this.lastHeartbeat, now)) {
      if (c.action !== "scan_pass" && c.action !== "scan_reject") continue;
      launches += c.count;
      if (c.action === "scan_pass") passed += c.count;
      if (!LAUNCH_TIME.has(c.reason)) judged += c.count;
    }
    return m.heartbeat({
      upMs: now - this.startedAt,
      sinceMs: now - this.lastHeartbeat,
      launches,
      judged,
      passed,
      opened: this.ledger.countOpenedBetween(this.lastHeartbeat, now),
      closed: this.ledger.closedBetween(this.lastHeartbeat, now).length,
      equity,
      startingSol: this.cfg.wallet.startingSol,
    });
  }
}
