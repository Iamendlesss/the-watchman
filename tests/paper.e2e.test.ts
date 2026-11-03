import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { runPaper } from "../src/paper";
import { PUMP_MINT_AUTHORITY } from "../src/scanner/pda";
import { CURVE_TOKENS, SUPPLY, eventData, pk, pumpLogs } from "./helpers";

const servers: Array<{ close: () => void }> = [];
const saved = { key: process.env.HELIUS_API_KEY, stream: process.env.STREAM_WS_URL };
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
  process.env.HELIUS_API_KEY = saved.key;
  if (saved.stream === undefined) delete process.env.STREAM_WS_URL;
  else process.env.STREAM_WS_URL = saved.stream;
});

const VT = 1_000_000_000_000_000n;
const vSol = (price: number) => BigInt(Math.round(price * 1e18));
const notification = (subscription: number, slot: number, logs: string[]) =>
  JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription, result: { context: { slot }, value: { signature: `sig-${subscription}-${slot}`, err: null, logs } } } });
const trade = (mint: string, user: string, isBuy: boolean, tokens: bigint, price: number) =>
  eventData("TradeEvent", { mint, user, is_buy: isBuy, token_amount: tokens, sol_amount: 100_000_000n, virtual_sol_reserves: vSol(price), virtual_token_reserves: VT, real_sol_reserves: 6_000_000_000n, real_token_reserves: CURVE_TOKENS - tokens, fee_basis_points: 95n, creator_fee_basis_points: 30n });

describe("paper trading end to end (mock pump.fun stream)", () => {
  it("enters a coin that passes the gate, recovers the stake at 2x, and exits on the trailing stop", async () => {
    const GOOD = pk(1), DEV = pk(2), CURVE = pk(701);
    const P = 5e-8; // about 50 SOL of virtual reserves, like a coin with real traction

    const rpc = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body) as { method: string };
        res.setHeader("content-type", "application/json");
        if (m.method === "getSignaturesForAddress") return res.end(JSON.stringify({ result: [] }));
        res.end(JSON.stringify({ result: { value: { data: { program: "spl-token-2022", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, extensions: [] } } } } } }));
      });
    });
    await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
    servers.push({ close: () => rpc.close() });

    const wss = new WebSocketServer({ port: 0 });
    servers.push({ close: () => wss.close() });
    const unsubscribed: number[] = [];
    const timers: NodeJS.Timeout[] = [];
    servers.push({ close: () => timers.forEach(clearTimeout) });
    let nextSub = 10;
    wss.on("connection", (s: WsSocket) => {
      s.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
        if (m.method === "logsUnsubscribe") return void unsubscribed.push(m.params[0] as number);
        const subId = nextSub++;
        const address = ((m.params[0] as { mentions: string[] }).mentions)[0]!;
        s.send(JSON.stringify({ jsonrpc: "2.0", result: subId, id: m.id }));
        if (address === PUMP_MINT_AUTHORITY) {
          const create = eventData("CreateEvent", { name: "Good", symbol: "GOOD", mint: GOOD, bonding_curve: CURVE, user: DEV, creator: DEV, token_total_supply: SUPPLY, virtual_token_reserves: VT, virtual_sol_reserves: vSol(P / 2), real_token_reserves: CURVE_TOKENS });
          s.send(notification(subId, 100, pumpLogs([create, trade(GOOD, DEV, true, SUPPLY / 50n, P / 2)])));
        } else if (address === CURVE) {
          for (let i = 0; i < 6; i++) s.send(notification(subId, 200 + i, pumpLogs([trade(GOOD, pk(50 + i), true, SUPPLY / 100n, P)])));
          // the coin is entered at about 4s; it doubles at ~5.6s, then falls back at ~8.6s
          timers.push(setTimeout(() => s.send(notification(subId, 300, pumpLogs([trade(GOOD, pk(90), true, 1000n, P * 2.3)]))), 5600));
          timers.push(setTimeout(() => s.send(notification(subId, 400, pumpLogs([trade(GOOD, pk(91), false, 1000n, P * 1.5)]))), 8600));
        }
      });
    });

    delete process.env.STREAM_WS_URL;
    process.env.HELIUS_API_KEY = "k";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-e2e-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const cfg = parseConfig({
      wallet: { startingSol: 3.75 },
      scanner: {
        observationSeconds: 3, earlyCheckSeconds: 1, earlyMinBuyers: 2, earlyMinSol: 0.5,
        heliusWsBase: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
        heliusRpcBase: `http://127.0.0.1:${(rpc.address() as { port: number }).port}`,
      },
      safety: { useRugcheck: false, minUniqueBuyers: 5, minRealSol: 1 },
      paths: { dbPath, stopFile: path.join(dir, "STOP") },
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const ledger = new Ledger(dbPath);
    const sent: string[] = [];
    const code = await runPaper(cfg, { minutes: 0.25, debug: false }, ledger, { enabled: true, send: (t) => sent.push(t) });
    const out = lines.join("\n");

    expect(code).toBe(0);
    expect(out).toMatch(/PASS .*GOOD/);
    expect(out).toMatch(/ENTER .*GOOD .*fee 1\.25%/);
    expect(out).toMatch(/PARTIAL .*GOOD\s+initial recovery at 2x/);
    expect(out).toMatch(/EXIT .*GOOD\s+trailing stop/);
    expect(out).toMatch(/=== Paper trading summary ===/);
    expect(out).toMatch(/Discord alerts: on/);
    // What Discord would have received, in order. (The daily report also goes out at start when it is past
    // dailyReportHourUtc, which depends on the clock, so it is left out here and tested on its own.)
    const msgs = sent.filter((t) => !t.startsWith("📊"));
    expect(msgs.map((t) => /^\S+ \*\*[^*]+\*\*/.exec(t)?.[0])).toEqual([
      "🟢 **Paper bot started.**",
      "📈 **BUY**",
      "💰 **PARTIAL SELL**",
      "✅ **SOLD**",
      "🔴 **Paper bot stopped**",
    ]);
    expect(msgs.slice(1, 4).every((t) => t.includes("`GOOD`"))).toBe(true);
    expect(msgs[3]).toMatch(/trailing stop/);

    const pos = ledger.db.prepare("SELECT * FROM positions").all() as { status: string; exit_reason: string; recovered_initial: number; realized_pnl_sol: number; strategy: string }[];
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({ status: "closed", exit_reason: "trailing stop", recovered_initial: 1, strategy: "snipe" });
    expect(pos[0]!.realized_pnl_sol).toBeGreaterThan(0);
    expect(ledger.cashSol(3.75)).toBeCloseTo(3.75 + pos[0]!.realized_pnl_sol, 9);
    expect(ledger.getOpenPositions()).toHaveLength(0);
    expect(unsubscribed.length).toBe(1); // the coin's stream was cancelled once the position closed
    ledger.close();
  }, 25_000);
});
