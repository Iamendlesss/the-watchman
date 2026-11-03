import { describe, expect, it } from "vitest";
import { buildDailyReport } from "../src/alerts/daily";
import { DISCORD_LIMIT, DiscordNotifier, clean, isDiscordWebhook } from "../src/alerts/discord";
import * as m from "../src/alerts/messages";
import { PaperAlerts } from "../src/alerts/paper-alerts";
import { parseConfig } from "../src/config";
import { Ledger, type Fill, type PositionRow } from "../src/ledger";
import type { Snapshot } from "../src/scanner/tracker";
import { pk } from "./helpers";

const URL_ = "https://discord.com/api/webhooks/123/secret-token";

/** A stand-in for fetch: records each post and answers with the next scripted response (204 when the script runs out). */
function fakeFetch(script: Array<{ status: number; body?: unknown } | "throw" | "hang"> = []) {
  const calls: { url: string; body: { content: string; allowed_mentions: unknown; username: string }; at: number }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), at: Date.now() });
    const r = script.shift() ?? { status: 204 };
    if (r === "throw") throw new Error("network down");
    if (r === "hang") return new Promise<Response>(() => {});
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("Discord webhook address check", () => {
  it("accepts only https Discord webhook addresses", () => {
    expect(isDiscordWebhook(URL_)).toBe(true);
    expect(isDiscordWebhook("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(isDiscordWebhook("http://discord.com/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhook("https://discord.com.evil.io/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhook("https://example.com/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhook("https://discord.com/channels/1")).toBe(false);
    expect(isDiscordWebhook("not a url")).toBe(false);
  });

  it("shows coin-supplied text as inline code with no way to break out of it", () => {
    expect(clean("PEPE")).toBe("`PEPE`");
    expect(clean("a`b\nc‮d")).toBe("`a'bcd`");
    expect(clean("x".repeat(40))).toBe(`\`${"x".repeat(19)}…\``);
    expect(clean("")).toBe("`?`");
  });
});

describe("DiscordNotifier", () => {
  it("does nothing without a webhook, and refuses an address that isn't Discord's", async () => {
    const f = fakeFetch();
    const off = new DiscordNotifier(undefined, { fetchFn: f.fn });
    off.send("hello");
    await off.flush(100);
    const log: string[] = [];
    const wrong = new DiscordNotifier("https://example.com/hook", { fetchFn: f.fn, log: (x) => log.push(x) });
    wrong.send("hello");
    await wrong.flush(100);
    expect(off.enabled).toBe(false);
    expect(wrong.enabled).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(log.join()).toMatch(/not a Discord webhook address/);
    expect(log.join()).not.toContain("example.com"); // the configured address is never echoed
  });

  it("posts the text with mentions switched off", async () => {
    const f = fakeFetch();
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 0 });
    n.send("hi @everyone");
    await n.flush(1000);
    expect(n.sent).toBe(1);
    expect(f.calls[0]!.url).toBe(URL_);
    expect(f.calls[0]!.body).toMatchObject({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });

  it("joins messages that back up into one post, keeps a gap between posts, and cuts text at Discord's limit", async () => {
    const f = fakeFetch();
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 150 });
    n.send("one");
    n.send("two");
    n.send("three");
    n.send("y".repeat(DISCORD_LIMIT + 50));
    await n.flush(3000);
    expect(f.calls.map((c) => c.body.content.slice(0, 20))).toEqual(["one", "two\nthree", "y".repeat(20)]);
    expect(f.calls[2]!.body.content).toHaveLength(DISCORD_LIMIT);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBeGreaterThanOrEqual(140);
  });

  it("tells each sender whether its message got through, including messages joined into one post", async () => {
    const f = fakeFetch([{ status: 204 }, { status: 404 }]);
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 50, maxQueue: 3, log: () => {} });
    const got: string[] = [];
    const cb = (name: string) => (ok: boolean) => got.push(`${name} ${ok}`);
    n.send("first", cb("first"));
    n.send("second", cb("second"));
    n.send("third", cb("third"));
    n.send("fourth", cb("fourth"));
    n.send("fifth", cb("fifth")); // four waiting is one too many: "second" is dropped
    await n.flush(2000);
    expect(got).toEqual(["second false", "first true", "third false", "fourth false", "fifth false"]);
    new DiscordNotifier(undefined).send("off", cb("off"));
    expect(got.at(-1)).toBe("off false");
  });

  it("waits out a rate limit and then delivers", async () => {
    const f = fakeFetch([{ status: 429, body: { retry_after: 0.3 } }]);
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 0 });
    n.send("after the limit");
    await n.flush(3000);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBeGreaterThanOrEqual(280);
    expect(n.sent).toBe(1);
  });

  it("does not retry a webhook Discord rejects, and never prints the address", async () => {
    const f = fakeFetch([{ status: 404 }]);
    const log: string[] = [];
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 0, log: (x) => log.push(x) });
    n.send("lost");
    await n.flush(1000);
    expect(f.calls).toHaveLength(1);
    expect(n.failed).toBe(1);
    expect(log.join()).toMatch(/HTTP 404/);
    expect(log.join()).not.toContain("secret-token");
  });

  it("retries network errors twice, then gives up without throwing", async () => {
    const f = fakeFetch(["throw", "throw", "throw"]);
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 0, log: () => {} });
    n.send("x");
    await n.flush(6000);
    expect(f.calls).toHaveLength(3);
    expect(n.failed).toBe(1);
    expect(n.sent).toBe(0);
  }, 10_000);

  it("stops waiting at the flush timeout if Discord hangs, and drops the oldest when too many are waiting", async () => {
    const f = fakeFetch(["hang"]);
    const n = new DiscordNotifier(URL_, { fetchFn: f.fn, minIntervalMs: 0, maxQueue: 2 });
    for (const t of ["a", "b", "c", "d"]) n.send(t);
    const t0 = Date.now();
    await n.flush(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(n.dropped).toBe(1); // "a" went out straight away; of b, c, d only the newest two are kept
  });
});

const T = Date.UTC(2026, 9, 25, 10); // 2026-10-25 10:00 UTC
const HOUR = 3_600_000;
const buy = (sol: number): Fill => ({ side: "buy", tokens: 1_000_000, priceSol: sol / 1_000_000, solAmount: sol, feesSol: 0.001, rentSol: 0, slippagePct: 0 });
const sell = (sol: number): Fill => ({ side: "sell", tokens: 1_000_000, priceSol: sol / 1_000_000, solAmount: sol, feesSol: 0.001, rentSol: 0, slippagePct: 0 });
function trade(ledger: Ledger, symbol: string, openedAt: number, closedAt: number, sellSol: number, reason: string): PositionRow {
  const id = ledger.openPosition({ mint: pk(symbol.length * 7), symbol, strategy: "snipe", ts: openedAt, fill: buy(0.04) });
  ledger.recordSell(id, closedAt, sell(sellSol), reason);
  return ledger.getPosition(id)!;
}

describe("messages", () => {
  const snap = { realSol: 25.94, uniqueBuyers: 310, top10Pct: 0.29, bundledPct: 0.16, runupMultiple: 3.5 } as Snapshot;

  it("describes a buy with the gate numbers and a pump.fun link", () => {
    const ledger = new Ledger(":memory:");
    const id = ledger.openPosition({ mint: pk(1), symbol: "Uni`corn", strategy: "snipe", ts: T, fill: buy(0.0419) });
    const text = m.opened(ledger.getPosition(id)!, snap);
    expect(text).toBe(
      `📈 **BUY** \`Uni'corn\` 0.0419 SOL. Curve 25.9 SOL, 310 buyers, top-10 29%, bundled 16%, run-up 3.5x. <https://pump.fun/coin/${pk(1)}>`,
    );
  });

  it("describes a closed trade as a share of its cost", () => {
    const ledger = new Ledger(":memory:");
    const p = trade(ledger, "WIN", T, T + 14 * 60_000, 0.06, "trailing stop");
    expect(m.closed(p)).toBe("✅ **SOLD** `WIN` +43.9% of cost (+0.0180 SOL). trailing stop, held 14m.");
    const q = trade(ledger, "LOSS", T, T + 2 * HOUR, 0.028, "hard stop-loss");
    expect(m.closed(q)).toBe("❌ **SOLD** `LOSS` -34.1% of cost (-0.0140 SOL). hard stop-loss, held 2.0h.");
  });

  it("explains the drawdown floor, and shows it when the bot starts", () => {
    const cfg = parseConfig({ wallet: { startingSol: 3.75 } });
    expect(m.floorHit(0.92, 1.33, cfg)).toBe(
      "🛑 **Drawdown floor hit**: equity 0.9200 SOL is 30.8% below the high-water mark of 1.3300 SOL (limit 30%). " +
        "No new trades until you run `npm run resume`. Open positions keep their normal exits.",
    );
    expect(m.started(cfg, 1.33, 0, 1.33, null)).toContain("Drawdown floor 0.9310 SOL (30% below the high-water mark of 1.3300 SOL).");
    expect(m.started(cfg, 1.33, 0, 1.9, "drawdown floor: x")).toMatch(/Trading is halted: drawdown floor: x\. Run `npm run resume`/);
    expect(m.riskBlocked("DRAWDOWN", "drawdown floor: x")).toMatch(/Trading halted/);
  });

  it("explains halts and outages in plain words", () => {
    expect(m.riskBlocked("HALTED", "halted until manual resume: daily loss")).toMatch(/Trading halted.*npm run resume/);
    expect(m.riskBlocked("LOSS_PAUSE", "8 losses in a row; paused 15 more min")).toBe(
      "⏸️ **New trades paused** (LOSS_PAUSE): 8 losses in a row; paused 15 more min.",
    );
    expect(m.streamDown(61_000, 2)).toBe("📡 **Stream down** for 61s (no connection open). 2 open position(s) are not being watched for exits.");
    expect(m.streamBack(150_000)).toBe("📡 Stream back after 3m.");
  });
});

describe("daily report", () => {
  it("summarises one UTC day: trades in percent of cost, exits, and what the gate did", () => {
    const cfg = parseConfig({ wallet: { startingSol: 3.75 } });
    const ledger = new Ledger(":memory:");
    trade(ledger, "AAA", T, T + HOUR, 0.06, "trailing stop"); // +43.9%
    trade(ledger, "BBB", T, T + 2 * HOUR, 0.028, "hard stop-loss"); // -34.1%
    trade(ledger, "CCCC", T, T + 3 * HOUR, 0.026, "hard stop-loss"); // -39.0%
    trade(ledger, "OTHERDAY", T - 2 * 24 * HOUR, T - 47 * HOUR, 0.05, "time stop"); // closed on another day
    const log = (minute: number, action: string, reason: string, n = 1) => {
      for (let i = 0; i < n; i++) ledger.logDecision({ ts: T + minute * 60_000, action, reason });
    };
    log(0, "scan_reject", "QUOTE_SOL", 3);
    log(1, "scan_reject", "EARLY_NO_TRACTION", 2);
    log(2, "scan_reject", "CURVE_SOL", 2);
    log(3, "scan_reject", "CURVE_SOL,CREATOR_SOLD");
    log(4, "scan_pass", "passed gate", 3);
    log(5, "reject", "LOSS_PAUSE");
    ledger.logDecision({ ts: T + 24 * HOUR, action: "scan_pass", reason: "passed gate" }); // next day, left out

    const text = buildDailyReport(ledger, cfg, "2026-10-25", 3.5);
    expect(text).toContain("📊 **Daily report for 2026-10-25 (UTC)**");
    expect(text).toContain("Ran about 0.1h. Equity now 3.5000 SOL (-6.7% since the 3.75 SOL start).");
    expect(text).toContain("**Trades closed: 3**, win rate 33% (1W/2L)");
    expect(text).toContain("Avg win +43.9%, avg loss -36.6%, **expectancy -9.8% per trade** (share of cost)");
    expect(text).toContain("P&L -0.0120 SOL, fees 0.0060 SOL (4.9% of cost)");
    expect(text).toContain("Best `AAA` +43.9% (trailing stop), worst `CCCC` -39.0% (hard stop-loss)");
    expect(text).toContain("Exits: hard stop-loss 2 (avg -36.6%), trailing stop 1 (avg +43.9%)");
    expect(text).toContain("**Gate:** 11 launches, 6 judged at 180s, 3 passed (27.27% of launches)");
    expect(text).toContain("Top rejections: CURVE_SOL 3, CREATOR_SOLD 1");
    expect(text).toContain("Entries blocked by risk rules: LOSS_PAUSE 1");
    expect(text).toContain("Last 4 trades overall: win rate 50%");
    expect(text.length).toBeLessThan(DISCORD_LIMIT);
    expect(text).not.toContain(";");
  });

  it("says so when the bot did not run that day", () => {
    const text = buildDailyReport(new Ledger(":memory:"), parseConfig({}), "2026-10-24", 3);
    expect(text).toMatch(/not running that day/);
  });
});

describe("PaperAlerts", () => {
  const setup = (alerts: object = {}, enabled = true) => {
    const sent: string[] = [];
    const cfg = parseConfig({ wallet: { startingSol: 3.75 }, alerts });
    const ledger = new Ledger(":memory:");
    const start = Date.UTC(2026, 9, 26, 3); // 03:00 UTC, before the 07:00 report hour
    const a = new PaperAlerts({ enabled, send: (t, done) => (sent.push(t), done?.(true)) }, cfg, ledger, start);
    return { sent, cfg, ledger, start, a };
  };

  it("tells you about a pause or halt once an hour, and ignores routine blocks", () => {
    const { a, sent, start } = setup();
    const pause = ["LOSS_PAUSE: 8 losses in a row; paused 15 more min", "COST_CAP: round-trip cost 9.0% exceeds 8% cap"];
    a.blocked(pause, start);
    a.blocked(pause, start + 10 * 60_000);
    a.blocked(["COST_CAP: round-trip cost 9.0% exceeds 8% cap"], start);
    a.blocked(["DAILY_LOSS: daily loss 36% of start-of-day equity"], start);
    a.blocked(["HALTED: halted until manual resume: daily loss"], start + 5 * 60_000);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/paused\*\* \(LOSS_PAUSE\)/);
    expect(sent[1]).toMatch(/Trading halted/);
    a.blocked(pause, start + 61 * 60_000);
    expect(sent).toHaveLength(3);
  });

  it("sends the floor alert straight away and then no extra halt reminder for an hour", () => {
    const { a, sent, start } = setup();
    a.floorHit(0.9, 1.33, start);
    a.blocked(["HALTED: halted until manual resume: drawdown floor: x"], start + 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Drawdown floor hit/);
    a.blocked(["HALTED: halted until manual resume: drawdown floor: x"], start + 61 * 60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/Trading halted/);
  });

  it("reports a stream outage only once it has lasted, and then when it ends", () => {
    const { a, sent, start } = setup();
    a.streamChange(true, start);
    a.streamChange(false, start + 5_000); // a short blip: nothing to say
    a.streamChange(true, start + 10_000);
    a.tick(start + 40_000, () => 3);
    expect(sent).toHaveLength(0);
    a.tick(start + 71_000, () => 3);
    a.tick(start + 80_000, () => 3);
    expect(sent).toEqual(["📡 **Stream down** for 61s (no connection open). No positions are open."]);
    a.streamChange(false, start + 100_000);
    expect(sent[1]).toBe("📡 Stream back after 90s.");
  });

  it("sends a heartbeat every few hours with what happened since the last one", () => {
    const { a, sent, start, ledger } = setup({ heartbeatHours: 0.5 });
    ledger.logDecision({ ts: start + 60_000, action: "scan_reject", reason: "QUOTE_SOL" });
    ledger.logDecision({ ts: start + 60_000, action: "scan_reject", reason: "CURVE_SOL" });
    ledger.logDecision({ ts: start + 60_000, action: "scan_pass", reason: "passed gate" });
    a.tick(start + 29 * 60_000, () => 3.6);
    expect(sent).toHaveLength(0);
    a.tick(start + 30 * 60_000, () => 3.6);
    expect(sent).toEqual([
      "💓 Still running (up 30m). Last 30m: 3 launches, 2 judged, 1 passed, 0 trade(s) opened, 0 closed. Equity 3.6000 SOL (-4.0% since the 3.75 SOL start).",
    ]);
  });

  it("sends the daily report once per day, even across restarts", () => {
    const { a, sent, cfg, ledger, start } = setup();
    a.tick(start + 3 * HOUR + 59 * 60_000, () => 3); // 06:59 UTC: not yet
    expect(sent).toHaveLength(0);
    a.tick(start + 4 * HOUR, () => 3); // 07:00 UTC
    a.tick(start + 5 * HOUR, () => 3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Daily report for 2026-10-25/);
    const restarted = new PaperAlerts({ enabled: true, send: (t, done) => (sent.push(t), done?.(true)) }, cfg, ledger, start + 6 * HOUR);
    restarted.tick(start + 6 * HOUR, () => 3);
    expect(sent).toHaveLength(1);
  });

  it("keeps the daily report until Discord confirms it, retrying 10 minutes after a failed attempt", () => {
    const cfg = parseConfig({});
    const ledger = new Ledger(":memory:");
    const sends: string[] = [];
    let pending: ((ok: boolean) => void) | undefined;
    const t7 = Date.UTC(2026, 9, 26, 7);
    const a = new PaperAlerts({ enabled: true, send: (t, done) => (sends.push(t), (pending = done)) }, cfg, ledger, t7);
    a.tick(t7, () => 3);
    a.tick(t7 + 1000, () => 3); // still waiting on the first attempt: not sent twice
    expect(sends).toHaveLength(1);
    pending!(false); // the network was down
    expect(ledger.hasDecision("alert", "daily report 2026-10-25")).toBe(false);
    a.tick(t7 + 9 * 60_000, () => 3);
    expect(sends).toHaveLength(1);
    a.tick(t7 + 10 * 60_000, () => 3);
    expect(sends).toHaveLength(2);
    pending!(true);
    expect(ledger.hasDecision("alert", "daily report 2026-10-25")).toBe(true);
    a.tick(t7 + 30 * 60_000, () => 3);
    expect(sends).toHaveLength(2);
  });

  it("does nothing on ticks when alerts are off, and doesn't mark the report as sent", () => {
    const { a, ledger, start } = setup({}, false);
    a.tick(start + 5 * HOUR, () => 3);
    expect(ledger.hasDecision("alert", "daily report 2026-10-25")).toBe(false);
  });
});
