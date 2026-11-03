import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { buildRiskInputs, resumeTrading, tryOpen, type Deps } from "../src/engine";
import { PaperExecutor, type Quote } from "../src/executor";
import { Ledger } from "../src/ledger";

const NOW = Date.UTC(2026, 8, 19, 12);
const q = (n: string, liquiditySol = 30): Quote => ({ mint: n, symbol: n, midPriceSol: 0.0001, liquiditySol });

function setup(over: object = {}, stop = false): Deps {
  const cfg = parseConfig(over);
  return { cfg, ledger: new Ledger(":memory:"), executor: new PaperExecutor(cfg), stopFilePresent: () => stop };
}

describe("engine.tryOpen", () => {
  it("opens a position and logs the decision", () => {
    const d = setup();
    const r = tryOpen(d, { quote: q("A"), strategy: "snipe" }, NOW);
    expect(r.opened).toBe(true);
    expect(d.ledger.getOpenPositions()).toHaveLength(1);
    expect(d.ledger.countDecisions()).toBe(1);
  });

  it("never opens more than the position cap", () => {
    const d = setup();
    const results = ["A", "B", "C", "D", "E", "F"].map((n) => tryOpen(d, { quote: q(n), strategy: "snipe" }, NOW));
    expect(results.filter((r) => r.opened)).toHaveLength(4);
    expect(d.ledger.getOpenPositions()).toHaveLength(4);
    expect(results[4]?.reasons.join()).toMatch(/MAX_POSITIONS/);
  });

  it("logs rejections too", () => {
    const d = setup();
    const r = tryOpen(d, { quote: q("THIN", 1.5), strategy: "momentum" }, NOW);
    expect(r.opened).toBe(false);
    expect(r.reasons.join()).toMatch(/COST_CAP/);
    expect(d.ledger.countDecisions()).toBe(1);
  });

  it("honors the kill switch", () => {
    const d = setup({}, true);
    const r = tryOpen(d, { quote: q("A"), strategy: "snipe" }, NOW);
    expect(r.opened).toBe(false);
    expect(r.reasons.join()).toMatch(/STOP_FILE/);
  });

  it("persists a halt when the daily loss limit is breached, and it survives a recovery", () => {
    const d = setup();
    tryOpen(d, { quote: q("A"), strategy: "snipe" }, NOW);
    // Pretend the day started at 10 SOL, so 3 SOL of equity is a 70% loss for the day.
    d.ledger.db.prepare("UPDATE day_equity SET equity_sol = 10").run();
    const r = tryOpen(d, { quote: q("B"), strategy: "snipe" }, NOW + 1000);
    expect(r.opened).toBe(false);
    expect(d.ledger.getHalt()?.reason).toMatch(/35%/);
    // Even if the day's starting equity now makes the account look fine, the halt still blocks.
    d.ledger.db.prepare("UPDATE day_equity SET equity_sol = 1").run();
    const again = tryOpen(d, { quote: q("C"), strategy: "snipe" }, NOW + 2000);
    expect(again.reasons.join()).toMatch(/HALTED/);
    // Only a manual resume lifts it, and a daily-loss resume leaves the drawdown high-water mark alone.
    const peak = d.ledger.getPeakEquity()!.peakSol;
    expect(resumeTrading(d.ledger, d.cfg, NOW + 3000)).toEqual({ cleared: "daily loss limit of 35% reached" });
    expect(d.ledger.getPeakEquity()!.peakSol).toBe(peak);
    expect(tryOpen(d, { quote: q("D"), strategy: "snipe" }, NOW + 4000).opened).toBe(true);
  });

  it("raises the high-water mark when equity makes a new high", () => {
    const d = setup();
    buildRiskInputs(d, NOW, new Map()); // seeds the mark at 3 SOL
    d.ledger.db.prepare("UPDATE equity_peak SET peak_sol = 2").run();
    expect(buildRiskInputs(d, NOW + 1, new Map()).peakEquitySol).toBe(3);
    expect(d.ledger.getPeakEquity()!.peakSol).toBe(3);
  });

  it("halts at the drawdown floor until resumed, and resuming restarts the high-water mark from today's equity", () => {
    const d = setup();
    expect(tryOpen(d, { quote: q("A"), strategy: "snipe" }, NOW).opened).toBe(true);
    d.ledger.resetPeakEquity(5, NOW); // equity of about 3 SOL is now 40% below a 5 SOL mark
    const r = tryOpen(d, { quote: q("B"), strategy: "snipe" }, NOW + 1000);
    expect(r.opened).toBe(false);
    expect(r.reasons.join()).toMatch(/^DRAWDOWN: drawdown floor: equity [23]\.\d{4} SOL is 40\.\d% below the high-water mark of 5\.0000 SOL/);
    expect(d.ledger.getHalt()?.reason).toMatch(/^drawdown floor/);
    expect(tryOpen(d, { quote: q("C"), strategy: "snipe" }, NOW + 2000).reasons.join()).toMatch(/HALTED/);
    const res = resumeTrading(d.ledger, d.cfg, NOW + 3000);
    expect(res.cleared).toMatch(/^drawdown floor/);
    expect(res.newPeakSol).toBeCloseTo(d.ledger.equitySol(3), 9);
    expect(d.ledger.getPeakEquity()!.peakSol).toBeCloseTo(res.newPeakSol!, 9);
    expect(tryOpen(d, { quote: q("D"), strategy: "snipe" }, NOW + 4000).opened).toBe(true);
    expect(resumeTrading(d.ledger, d.cfg, NOW + 5000)).toEqual({ cleared: null });
  });
});
