import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { parseConfig } from "../src/config";
import { Ledger } from "../src/ledger";
import { runScan } from "../src/scan";
import { PUMP_MINT_AUTHORITY } from "../src/scanner/pda";
import { CURVE_TOKENS, SUPPLY, eventData, pk, pumpLogs } from "./helpers";

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  servers.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
});

const notification = (subscription: number, slot: number, logs: string[]) =>
  JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription, result: { context: { slot }, value: { signature: `sig-${subscription}-${slot}-${logs.length}`, err: null, logs } } } });

const create = (mint: string, creator: string, curve: string, over: Record<string, unknown> = {}) =>
  eventData("CreateEvent", { name: "Coin " + mint.slice(0, 3), symbol: "C" + mint.slice(0, 3), mint, bonding_curve: curve, user: creator, creator, token_total_supply: SUPPLY, virtual_token_reserves: 1_073_000_000_000_000n, virtual_sol_reserves: 30_000_000_000n, real_token_reserves: CURVE_TOKENS, ...over });
const trade = (mint: string, user: string, isBuy: boolean, tokens: bigint) =>
  eventData("TradeEvent", { mint, user, is_buy: isBuy, token_amount: tokens, sol_amount: 100_000_000n, virtual_sol_reserves: 33_000_000_000n, virtual_token_reserves: 1_000_000_000_000_000n, real_sol_reserves: 6_000_000_000n, real_token_reserves: CURVE_TOKENS - tokens, fee_basis_points: 95n, creator_fee_basis_points: 30n });

describe("scan command end to end (mock Helius: two-tier design)", () => {
  it("skips, drops, backfills and judges launches, and reports data use", async () => {
    const GOOD = pk(1), GOOD_DEV = pk(2), GOOD_CURVE = pk(601);
    const BAD = pk(3), BAD_DEV = pk(4), BAD_CURVE = pk(602);
    const DEAD = pk(5), DEAD_DEV = pk(6), DEAD_CURVE = pk(603);
    const USDC = pk(7), USDC_DEV = pk(8);
    const MAYHEM = pk(9), MAYHEM_DEV = pk(10);

    // ---- mock RPC: mint account, plus the backfill calls ----
    const rpcCalls: string[] = [];
    const rpc = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const m = JSON.parse(body) as { method: string; params: unknown[] };
        rpcCalls.push(m.method);
        res.setHeader("content-type", "application/json");
        if (m.method === "getSignaturesForAddress") return res.end(JSON.stringify({ result: [{ signature: "GAP1", slot: 101, err: null }] }));
        if (m.method === "getTransaction")
          return res.end(JSON.stringify({ result: { slot: 101, meta: { err: null, logMessages: pumpLogs([trade(GOOD, pk(60), true, SUPPLY / 100n)]) } } }));
        res.end(JSON.stringify({ result: { value: { data: { program: "spl-token-2022", parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, extensions: [] } } } } } }));
      });
    });
    await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", r));
    servers.push({ close: () => rpc.close() });

    // ---- mock WebSocket: launches on the mint-authority subscription, trades on each curve subscription ----
    const wss = new WebSocketServer({ port: 0 });
    servers.push({ close: () => wss.close() });
    const subAddress = new Map<number, string>();
    const unsubscribed: number[] = [];
    let nextSub = 10;
    wss.on("connection", (s: WsSocket) => {
      s.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
        if (m.method === "logsUnsubscribe") return void unsubscribed.push(m.params[0] as number);
        const subId = nextSub++;
        const address = ((m.params[0] as { mentions: string[] }).mentions)[0]!;
        subAddress.set(subId, address);
        s.send(JSON.stringify({ jsonrpc: "2.0", result: subId, id: m.id }));
        if (address === PUMP_MINT_AUTHORITY) {
          s.send(notification(subId, 100, pumpLogs([create(GOOD, GOOD_DEV, GOOD_CURVE), trade(GOOD, GOOD_DEV, true, SUPPLY / 50n)])));
          s.send(notification(subId, 100, pumpLogs([create(BAD, BAD_DEV, BAD_CURVE), trade(BAD, BAD_DEV, true, SUPPLY / 50n)]).concat(["Program log: bad"])));
          s.send(notification(subId, 100, pumpLogs([create(DEAD, DEAD_DEV, pk(603))])));
          s.send(notification(subId, 100, pumpLogs([create(USDC, USDC_DEV, pk(604), { quote_mint: pk(50) })])));
          s.send(notification(subId, 100, pumpLogs([create(MAYHEM, MAYHEM_DEV, pk(605), { is_mayhem_mode: true })])));
        } else if (address === GOOD_CURVE) {
          for (let i = 0; i < 6; i++) s.send(notification(subId, 200 + i, pumpLogs([trade(GOOD, pk(50 + i), true, SUPPLY / 100n)])));
        } else if (address === BAD_CURVE) {
          s.send(notification(subId, 300, pumpLogs([trade(BAD, BAD_DEV, false, SUPPLY / 50n)])));
          for (let i = 0; i < 6; i++) s.send(notification(subId, 301 + i, pumpLogs([trade(BAD, pk(70 + i), true, SUPPLY / 100n)])));
        }
      });
    });
    void DEAD_CURVE;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-e2e-"));
    const cfg = parseConfig({
      scanner: {
        observationSeconds: 3, earlyCheckSeconds: 1, earlyMinBuyers: 2, earlyMinSol: 0.5,
        heliusWsBase: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
        heliusRpcBase: `http://127.0.0.1:${(rpc.address() as { port: number }).port}`,
      },
      safety: { useRugcheck: false, minUniqueBuyers: 5, minRealSol: 1 },
      paths: { dbPath: path.join(dir, "ledger.sqlite"), stopFile: "STOP" },
    });
    process.env.HELIUS_API_KEY = "test-key-should-never-be-printed";
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));

    const code = await runScan(cfg, { minutes: 0.11, debug: true });
    const out = lines.join("\n");

    expect(code).toBe(0);
    // Launch-time skips never got a coin subscription; the dead coin was dropped early; the others were judged.
    expect(out).toMatch(/Launches seen:\s+5/);
    expect(out).toMatch(/Skipped at launch:\s+2 \((QUOTE_SOL 1, MAYHEM_MODE 1|MAYHEM_MODE 1, QUOTE_SOL 1)\)/);
    expect(out).toMatch(/Dropped early:\s+1/);
    expect(out).toMatch(/Judged \/ passed:\s+2 \/ 1/);
    expect(out).toContain(`PASS    $C${GOOD.slice(0, 3)} ${GOOD}`);
    expect(out).toMatch(/REJECT .*CREATOR_SOLD/);
    // Only the coin that cleared the cheap gate was backfilled (1 signature lookup + 1 transaction).
    expect(out).toMatch(/Backfilled:\s+1 coins, 1 early trades recovered/);
    expect(rpcCalls.filter((m) => m === "getSignaturesForAddress")).toHaveLength(1);
    expect(rpcCalls.filter((m) => m === "getTransaction")).toHaveLength(1);
    expect(out).toMatch(/RPC:\s+3 calls/); // backfill (2) + mint check (1)
    expect(out).toMatch(/Median trade fees:\s+125 bps/);
    // Every coin subscription was cancelled when its coin was finished with (GOOD, BAD, DEAD).
    expect(unsubscribed.length).toBe(3);
    expect(out).not.toContain("test-key-should-never-be-printed");
    expect(out).not.toMatch(/127\.0\.0\.1/);

    const ledger = new Ledger(cfg.paths.dbPath);
    const rows = ledger.db.prepare("SELECT action, mint, reason, details FROM decisions ORDER BY id").all() as { action: string; mint: string; reason: string; details: string | null }[];
    ledger.close();
    const by = (m: string) => rows.find((r) => r.mint === m);
    expect(by(GOOD)?.action).toBe("scan_pass");
    expect(by(BAD)).toMatchObject({ action: "scan_reject", reason: expect.stringContaining("CREATOR_SOLD") });
    // A coin rejected at the final gate keeps the numbers behind the verdict, for threshold analysis later.
    const badDetails = JSON.parse(by(BAD)!.details!) as Record<string, unknown>;
    expect(badDetails).toMatchObject({ stage: "stream", creatorSoldPct: 1, sellCount: 1 });
    expect(badDetails.realSol).toBeGreaterThan(0);
    expect(badDetails.uniqueBuyers).toBeGreaterThanOrEqual(6);
    expect(by(DEAD)!.details).toBeNull(); // the early cut stays a bare reason
    expect(by(DEAD)).toMatchObject({ action: "scan_reject", reason: "EARLY_NO_TRACTION" });
    expect(by(USDC)).toMatchObject({ action: "scan_reject", reason: "QUOTE_SOL" });
    expect(by(MAYHEM)).toMatchObject({ action: "scan_reject", reason: "MAYHEM_MODE" });
  }, 20_000);

  it("refuses to run without a Helius key", async () => {
    const saved = process.env.HELIUS_API_KEY;
    process.env.HELIUS_API_KEY = "";
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runScan(parseConfig({}), { minutes: 1, debug: false })).toBe(1);
    expect(err).toHaveBeenCalled();
    process.env.HELIUS_API_KEY = saved;
  });
});
