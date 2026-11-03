import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { runScan } from "../src/scan";

const servers: Array<{ close: () => void }> = [];
const saved = { key: process.env.HELIUS_API_KEY, stream: process.env.STREAM_WS_URL };
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
  process.env.HELIUS_API_KEY = saved.key;
  if (saved.stream === undefined) delete process.env.STREAM_WS_URL;
  else process.env.STREAM_WS_URL = saved.stream;
});

/** A WebSocket that acknowledges subscriptions and pushes one large message, to generate streamed bytes. */
function bulkyServer(): { url: string } {
  const wss = new WebSocketServer({ port: 0 });
  servers.push({ close: () => wss.close() });
  wss.on("connection", (s: WsSocket) => {
    s.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string };
      if (m.method !== "logsSubscribe") return;
      s.send(JSON.stringify({ jsonrpc: "2.0", result: 1, id: m.id }));
      s.send(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 1, result: { context: { slot: 1 }, value: { signature: "x", err: null, logs: ["Program log: " + "a".repeat(300_000)] } } } }));
    });
  });
  return { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}
const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "scan-budget-")), "ledger.sqlite");
const capture = () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  return lines;
};

describe("scan credit budget and custom stream", () => {
  it("stops early and records credits once the daily budget is spent", async () => {
    const srv = bulkyServer();
    delete process.env.STREAM_WS_URL;
    process.env.HELIUS_API_KEY = "k";
    const dbPath = tmpDb();
    const cfg = parseConfig({ scanner: { dailyCreditBudget: 1, heliusWsBase: srv.url, heliusRpcBase: "http://127.0.0.1:1" }, paths: { dbPath, stopFile: "STOP" } });
    const lines = capture();
    await runScan(cfg, { minutes: 1, debug: false }); // would run a minute; the guard must end it in seconds
    const out = lines.join("\n");
    expect(out).toMatch(/Stopped early: today's Helius credit budget \(1\) was reached/);
    expect(out).toMatch(/Stream: +1 connection\(s\)/); // Helius data costs credits, so never a second connection
    expect(out).not.toMatch(/\[B\]/);
    const l = new Ledger(dbPath);
    expect(l.creditsUsed(new Date().toISOString().slice(0, 10))).toBeGreaterThan(1);
    l.close();
  }, 20_000);

  it("refuses to start when today's budget is already spent", async () => {
    process.env.HELIUS_API_KEY = "k";
    delete process.env.STREAM_WS_URL;
    const dbPath = tmpDb();
    const l = new Ledger(dbPath);
    l.addCredits(new Date().toISOString().slice(0, 10), 5000);
    l.close();
    const lines = capture();
    await runScan(parseConfig({ scanner: { dailyCreditBudget: 5000 }, paths: { dbPath, stopFile: "STOP" } }), { minutes: 1, debug: false });
    expect(lines.join("\n")).toMatch(/already used up/);
  });

  it("uses STREAM_WS_URL for the stream, sends no Helius key to it, and counts no stream credits", async () => {
    const srv = bulkyServer();
    process.env.STREAM_WS_URL = srv.url;
    process.env.HELIUS_API_KEY = "helius-secret-should-not-leak";
    const dbPath = tmpDb();
    // Helius's own WebSocket base points nowhere, so any use of it would fail the test.
    const cfg = parseConfig({
      scanner: { heliusWsBase: "ws://127.0.0.1:1", heliusRpcBase: "http://127.0.0.1:1", streamStaggerSeconds: 0.2 },
      paths: { dbPath, stopFile: "STOP" },
    });
    const lines = capture();
    await runScan(cfg, { minutes: 0.04, debug: false });
    const out = lines.join("\n");
    expect(out).toMatch(/Live stream: custom provider \(STREAM_WS_URL\)/);
    expect(out).toMatch(/= 0 credits \(custom provider: no Helius credits\)/);
    // The free stream runs on two connections by default, so a drop on one doesn't leave the bot blind.
    expect(out).toMatch(/stream: \[A\] subscribed to launches/);
    expect(out).toMatch(/stream: \[B\] subscribed to launches/);
    expect(out).toMatch(/Stream: {13}2 connection\(s\), 0 drop\(s\), blind 0s/);
    expect(out).not.toContain("helius-secret-should-not-leak");
    expect(out).not.toMatch(/127\.0\.0\.1/);
  }, 15_000);

  it("ends the run cleanly when the Terminal window is closed (SIGHUP), and leaves no signal listeners behind", async () => {
    const srv = bulkyServer();
    process.env.STREAM_WS_URL = srv.url;
    process.env.HELIUS_API_KEY = "k";
    const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const;
    const counts = () => signals.map((s) => process.listenerCount(s));
    const before = counts();
    const old = new Set(process.listeners("SIGHUP"));
    const cfg = parseConfig({ scanner: { heliusRpcBase: "http://127.0.0.1:1" }, paths: { dbPath: tmpDb(), stopFile: "STOP" } });
    const lines = capture();
    const t0 = Date.now();
    const run = runScan(cfg, { minutes: 10, debug: false });
    let ours: ((...a: unknown[]) => void) | undefined;
    for (let i = 0; i < 100 && !ours; i++) {
      ours = process.listeners("SIGHUP").find((l) => !old.has(l)) as typeof ours;
      if (!ours) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));
    ours!("SIGHUP"); // call only this run's handler, not the test runner's own
    await run;
    expect(Date.now() - t0).toBeLessThan(5000); // long before the 10 minutes were up
    expect(lines.join("\n")).toMatch(/=== Scan report ===/);
    expect(counts()).toEqual(before);
  }, 15_000);
});
