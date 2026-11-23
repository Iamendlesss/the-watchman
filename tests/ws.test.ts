import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { LogStream, RedundantLogStream } from "../src/scanner/ws";

const servers: WebSocketServer[] = [];
let stream: LogStream | undefined;
let redundant: RedundantLogStream | undefined;
afterEach(() => {
  stream?.stop();
  redundant?.stop();
  redundant = undefined;
  servers.splice(0).forEach((s) => s.close());
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await wait(20);
  if (!cond()) throw new Error("timed out waiting for condition");
}

const notification = (subscription: number, slot: number, logs: string[], err: unknown = null) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: { subscription, result: { context: { slot }, value: { signature: `sig${slot}`, err, logs } } },
  });

/**
 * A mock Helius: hands out subscription ids, records requests, and lets a test push notifications. Setting
 * `accept` to false refuses new connections, like a provider that is down.
 */
function mockServer() {
  const wss = new WebSocketServer({ port: 0, verifyClient: () => state.accept });
  servers.push(wss);
  const state = {
    accept: true,
    port: (wss.address() as { port: number }).port,
    subs: new Map<number, string>(), // subscription id -> mentioned address
    requests: [] as Array<{ method: string; params: unknown[] }>,
    unsubscribed: [] as number[],
    sockets: [] as WsSocket[],
    nextSub: 100,
    onSubscribe: (_sock: WsSocket, _subId: number, _address: string) => {},
  };
  wss.on("connection", (s: WsSocket) => {
    state.sockets.push(s);
    s.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
      state.requests.push({ method: m.method, params: m.params });
      if (m.method === "logsSubscribe") {
        const subId = state.nextSub++;
        const address = ((m.params[0] as { mentions: string[] }).mentions)[0]!;
        state.subs.set(subId, address);
        s.send(JSON.stringify({ jsonrpc: "2.0", result: subId, id: m.id }));
        state.onSubscribe(s, subId, address);
      } else if (m.method === "logsUnsubscribe") {
        state.unsubscribed.push(m.params[0] as number);
        s.send(JSON.stringify({ jsonrpc: "2.0", result: true, id: m.id }));
      }
    });
  });
  return state;
}

describe("LogStream", () => {
  it("routes each subscription's logs to its own handler and drops failed transactions", async () => {
    const srv = mockServer();
    srv.onSubscribe = (sock, subId, address) => {
      sock.send(notification(subId, 7, [`data for ${address}`]));
      sock.send(notification(subId, 8, ["failed tx"], { InstructionError: [0, "x"] }));
      sock.send("not json");
      sock.send(JSON.stringify({ method: "somethingElse" }));
    };
    const a: string[][] = [];
    const b: string[][] = [];
    const subscribed: string[] = [];
    const status: string[] = [];
    let bytes = 0;
    stream = new LogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      onBytes: (n) => (bytes += n),
      onStatus: (m) => status.push(m),
      onSubscribed: (id) => subscribed.push(id),
    });
    stream.subscribe("A", "ADDR_A", (_s, logs) => a.push(logs)); // subscribed before the socket is even open
    stream.start();
    stream.subscribe("B", "ADDR_B", (_s, logs) => b.push(logs));
    await until(() => a.length === 1 && b.length === 1);
    await wait(100);
    expect(a).toEqual([["data for ADDR_A"]]);
    expect(b).toEqual([["data for ADDR_B"]]);
    expect(subscribed.sort()).toEqual(["A", "B"]);
    expect(bytes).toBeGreaterThan(100);
    expect(stream.activeSubscriptions).toBe(2);
    expect(stream.failedDropped).toBe(2); // one failed transaction per subscription
    expect(stream.notifications).toBe(4);
    expect(srv.requests.filter((r) => r.method === "logsSubscribe")[0]?.params).toEqual([{ mentions: ["ADDR_A"] }, { commitment: "confirmed" }]);
    expect(status.join()).not.toMatch(/127\.0\.0\.1/); // the URL (and therefore the API key) is never reported
  });

  it("unsubscribes on request and stops delivering", async () => {
    const srv = mockServer();
    let pushed: { sock: WsSocket; subId: number } | undefined;
    srv.onSubscribe = (sock, subId) => (pushed = { sock, subId });
    const got: number[] = [];
    stream = new LogStream({ url: `ws://127.0.0.1:${srv.port}` });
    stream.subscribe("A", "ADDR_A", (slot) => got.push(slot));
    stream.start();
    await until(() => pushed !== undefined);
    pushed!.sock.send(notification(pushed!.subId, 1, ["x"]));
    await until(() => got.length === 1);
    stream.unsubscribe("A");
    await until(() => srv.unsubscribed.length === 1);
    expect(srv.unsubscribed).toEqual([pushed!.subId]);
    pushed!.sock.send(notification(pushed!.subId, 2, ["y"]));
    await wait(150);
    expect(got).toEqual([1]);
    expect(stream.activeSubscriptions).toBe(0);
  });

  it("cancels a subscription that is unsubscribed before the server has answered", async () => {
    const srv = mockServer();
    const wss = servers.at(-1)!;
    // Delay the reply so the unsubscribe happens while the request is still in flight.
    wss.removeAllListeners("connection");
    wss.on("connection", (s: WsSocket) => {
      s.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as { id: number; method: string; params: unknown[] };
        if (m.method === "logsSubscribe") setTimeout(() => s.send(JSON.stringify({ jsonrpc: "2.0", result: 555, id: m.id })), 200);
        if (m.method === "logsUnsubscribe") srv.unsubscribed.push(m.params[0] as number);
      });
    });
    stream = new LogStream({ url: `ws://127.0.0.1:${srv.port}` });
    stream.subscribe("A", "ADDR_A", () => {});
    stream.start();
    await wait(100); // socket open, subscribe sent, no reply yet
    stream.unsubscribe("A");
    await until(() => srv.unsubscribed.length === 1);
    expect(srv.unsubscribed).toEqual([555]);
  });

  it("can be stopped and started again, re-creating its subscriptions, without reporting a close it never opened", async () => {
    const srv = mockServer();
    const status: string[] = [];
    const changes: boolean[] = [];
    const subscribed: string[] = [];
    stream = new LogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      onStatus: (m) => status.push(m),
      onConnectionChange: (open) => changes.push(open),
      onSubscribed: (id) => subscribed.push(id),
    });
    stream.subscribe("A", "ADDR_A", () => {});
    stream.start();
    await until(() => subscribed.length === 1);
    stream.stop();
    srv.accept = false;
    stream.start(); // this first attempt is refused
    await until(() => status.some((m) => m.startsWith("disconnected")));
    srv.accept = true;
    await until(() => subscribed.length === 2, 6000);
    expect(changes).toEqual([true, true]);
    expect(srv.subs.size).toBe(2); // the subscription was created again on the new connection
  }, 10_000);

  it("replaces a connection that goes silent straight away, with one message per stall", async () => {
    const srv = mockServer(); // answers subscriptions but never sends any data
    const status: string[] = [];
    const changes: boolean[] = [];
    stream = new LogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      stallMs: 300,
      onStatus: (m) => status.push(m),
      onConnectionChange: (o) => changes.push(o),
    });
    stream.subscribe("A", "ADDR_A", () => {});
    const t0 = Date.now();
    stream.start();
    await until(() => srv.requests.filter((r) => r.method === "logsSubscribe").length >= 2, 3000);
    expect(Date.now() - t0).toBeLessThan(900); // no reconnect backoff (1s or more) was waited out
    expect(status.filter((m) => m.startsWith("no data"))).toEqual(["no data for 0s; replacing the connection"]);
    expect(status.some((m) => m.startsWith("disconnected"))).toBe(false); // the abandoned socket's close is ignored
    expect(stream.reconnects).toBe(1);
    expect(changes.slice(0, 3)).toEqual([true, false, true]);
  });

  it("reconnects and re-creates every active subscription after the server drops the connection", async () => {
    const srv = mockServer();
    let connections = 0;
    srv.onSubscribe = (sock, subId, address) => {
      if (address === "ADDR_A") {
        sock.send(notification(subId, ++connections, ["x"]));
        if (connections === 1) setTimeout(() => sock.close(), 50);
      }
    };
    const slots: number[] = [];
    const status: string[] = [];
    const changes: boolean[] = [];
    stream = new LogStream({ url: `ws://127.0.0.1:${srv.port}`, onStatus: (m) => status.push(m), onConnectionChange: (o) => changes.push(o) });
    stream.subscribe("A", "ADDR_A", (slot) => slots.push(slot));
    stream.subscribe("B", "ADDR_B", () => {});
    stream.start();
    await until(() => slots.length >= 2, 6000);
    expect(slots.slice(0, 2)).toEqual([1, 2]);
    expect(stream.reconnects).toBeGreaterThanOrEqual(1);
    expect(status.join("\n")).toMatch(/disconnected \(code 1005\); reconnecting in/); // the close code is reported
    expect(changes.slice(0, 3)).toEqual([true, false, true]);
    const subscribeCalls = srv.requests.filter((r) => r.method === "logsSubscribe").map((r) => ((r.params[0] as { mentions: string[] }).mentions)[0]);
    expect(subscribeCalls.filter((x) => x === "ADDR_B")).toHaveLength(2); // once per connection
  }, 10_000);
});

describe("RedundantLogStream", () => {
  it("delivers a transaction that arrives on several connections once", async () => {
    const srv = mockServer();
    srv.onSubscribe = (sock, subId) => {
      const second = srv.sockets.indexOf(sock) === 1;
      sock.send(notification(subId, 7, ["shared"])); // same signature on both connections
      sock.send(notification(subId, second ? 9 : 8, ["own"]));
    };
    const slots: number[] = [];
    const status: string[] = [];
    const subscribed: string[] = [];
    redundant = new RedundantLogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      connections: 2,
      staggerMs: 50,
      onStatus: (m) => status.push(m),
      onSubscribed: (id, label) => subscribed.push(`${label}${id}`),
    });
    redundant.subscribe("A", "ADDR_A", (slot) => slots.push(slot));
    redundant.start();
    await until(() => slots.length === 3);
    await wait(100);
    expect(slots.sort()).toEqual([7, 8, 9]);
    expect(redundant.duplicatesDropped).toBe(1);
    expect(redundant.notifications).toBe(4);
    expect(redundant.activeSubscriptions).toBe(1);
    expect(subscribed.sort()).toEqual(["[A] A", "[B] A"]);
    expect(status.some((m) => m.startsWith("[A] connected"))).toBe(true);
    expect(status.some((m) => m.startsWith("[B] connected"))).toBe(true);
    expect(status.join()).not.toMatch(/127\.0\.0\.1/);
  });

  it("unsubscribes on every connection", async () => {
    const srv = mockServer();
    redundant = new RedundantLogStream({ url: `ws://127.0.0.1:${srv.port}`, connections: 2, staggerMs: 0 });
    redundant.subscribe("A", "ADDR_A", () => {});
    redundant.start();
    await until(() => srv.subs.size === 2);
    redundant.unsubscribe("A");
    await until(() => srv.unsubscribed.length === 2);
    expect(redundant.activeSubscriptions).toBe(0);
  });

  it("keeps data flowing while one connection reconnects, and counts blind time only when all are down", async () => {
    const srv = mockServer();
    const live: Array<{ sock: WsSocket; subId: number }> = [];
    srv.onSubscribe = (sock, subId) => live.push({ sock, subId });
    const slots: number[] = [];
    const status: string[] = [];
    const blind: boolean[] = [];
    redundant = new RedundantLogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      connections: 2,
      staggerMs: 50,
      onStatus: (m) => status.push(m),
      onBlindChange: (b) => blind.push(b),
    });
    redundant.subscribe("A", "ADDR_A", (slot) => slots.push(slot));
    redundant.start();
    await until(() => live.length === 2);
    // Cut the first connection the way the public RPC does, then send a transaction on the second while the
    // first is still reconnecting.
    live[0]!.sock.terminate();
    await until(() => status.some((m) => m.startsWith("[A] disconnected (code 1006)")));
    live[1]!.sock.send(notification(live[1]!.subId, 1, ["x"]));
    await until(() => slots.length === 1);
    expect(redundant.blindMs).toBe(0);
    expect(blind).toEqual([]); // one connection down is not blind
    expect(status.join("\n")).not.toMatch(/all connections are down/);
    // Now cut every connection: that is blind time.
    await until(() => live.length === 3, 6000); // the first connection is back
    for (const s of srv.sockets) s.terminate();
    await until(() => status.some((m) => m.startsWith("a connection is back")), 6000);
    expect(status.join("\n")).toMatch(/all connections are down/);
    expect(redundant.blindMs).toBeGreaterThan(500);
    expect(blind).toEqual([true, false]);
    expect(redundant.reconnects).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("with one connection, adds no labels and opens one socket", async () => {
    const srv = mockServer();
    const status: string[] = [];
    const labels: string[] = [];
    redundant = new RedundantLogStream({
      url: `ws://127.0.0.1:${srv.port}`,
      connections: 1,
      onStatus: (m) => status.push(m),
      onSubscribed: (_id, label) => labels.push(label),
    });
    redundant.subscribe("A", "ADDR_A", () => {});
    redundant.start();
    await until(() => labels.length === 1);
    await wait(100);
    expect(labels).toEqual([""]);
    expect(redundant.connections).toBe(1);
    expect(status[0]).toMatch(/^connected/);
    expect(srv.sockets).toHaveLength(1);
  });
});

describe("RedundantLogStream backup connection", () => {
  it("opens only after every main connection has been down a while, and closes once one has stayed up", async () => {
    const main = mockServer();
    const backup = mockServer();
    const mainLive: Array<{ sock: WsSocket; subId: number }> = [];
    const backupLive: Array<{ sock: WsSocket; subId: number }> = [];
    main.onSubscribe = (sock, subId) => mainLive.push({ sock, subId });
    backup.onSubscribe = (sock, subId) => backupLive.push({ sock, subId });
    const slots: number[] = [];
    const status: string[] = [];
    const blind: boolean[] = [];
    let mainBytes = 0;
    let backupBytes = 0;
    redundant = new RedundantLogStream({
      url: `ws://127.0.0.1:${main.port}`,
      connections: 1,
      onBytes: (n) => (mainBytes += n),
      onStatus: (m) => status.push(m),
      onBlindChange: (b) => blind.push(b),
      backup: {
        url: `ws://127.0.0.1:${backup.port}/?api-key=secret`,
        label: "Helius",
        afterMs: 300,
        holdMs: 1500,
        onBytes: (n) => (backupBytes += n),
      },
    });
    redundant.subscribe("A", "ADDR_A", (slot) => slots.push(slot));
    redundant.start();
    await until(() => mainLive.length === 1);
    await wait(600); // longer than afterMs: a healthy main connection never opens the backup
    expect(backup.sockets).toHaveLength(0);

    // The main provider goes down and refuses to come back for now.
    main.accept = false;
    mainLive[0]!.sock.terminate();
    await until(() => backupLive.length === 1);
    expect(status.join("\n")).toMatch(/\[Helius\] every main connection has been down for 0\.\ds; opening the backup/);
    const mainBytesBefore = mainBytes;
    backupLive[0]!.sock.send(notification(backupLive[0]!.subId, 5, ["via backup"]));
    await until(() => slots.includes(5));
    expect(backupBytes).toBeGreaterThan(0);
    expect(mainBytes).toBe(mainBytesBefore); // the backup's data is counted apart from the main stream's
    expect(blind).toEqual([true, false]);
    expect(redundant.blindMs).toBeLessThan(2000);

    // The main provider is back. While both are open, a transaction on both is delivered once.
    main.accept = true;
    await until(() => mainLive.length === 2, 8000);
    mainLive[1]!.sock.send(notification(mainLive[1]!.subId, 6, ["both"]));
    backupLive[0]!.sock.send(notification(backupLive[0]!.subId, 6, ["both"]));
    await until(() => slots.includes(6));
    await wait(100);
    expect(slots.filter((s) => s === 6)).toHaveLength(1);

    // Once the main connection has stayed up for holdMs, the backup closes, and that is not blind time.
    await until(() => status.some((m) => m.includes("closing the backup: a main connection has been up")), 5000);
    await until(() => backup.sockets.every((s) => s.readyState === s.CLOSED));
    expect(redundant.backupUses).toBe(1);
    expect(redundant.backupMs).toBeGreaterThan(1000);
    expect(blind).toEqual([true, false]);
    expect(status.join("\n")).not.toMatch(/127\.0\.0\.1|secret/);
  }, 20_000);

  it("stays shut while blocked (for example by its credit cap), and closes when it becomes blocked", async () => {
    const main = mockServer();
    const backup = mockServer();
    let mainSock: WsSocket | undefined;
    main.onSubscribe = (sock) => (mainSock = sock);
    const status: string[] = [];
    const blind: boolean[] = [];
    let blocked: string | null = "cap used up";
    redundant = new RedundantLogStream({
      url: `ws://127.0.0.1:${main.port}`,
      connections: 1,
      onStatus: (m) => status.push(m),
      onBlindChange: (b) => blind.push(b),
      backup: { url: `ws://127.0.0.1:${backup.port}`, label: "Helius", afterMs: 100, holdMs: 0, blocked: () => blocked },
    });
    redundant.subscribe("A", "ADDR_A", () => {});
    redundant.start();
    await until(() => mainSock !== undefined);
    main.accept = false;
    mainSock!.terminate();
    await until(() => status.some((m) => m === "[Helius] backup not opened: cap used up"));
    await wait(400);
    expect(backup.sockets).toHaveLength(0);
    expect(redundant.backupUses).toBe(0);
    expect(status.filter((m) => m.includes("backup not opened"))).toHaveLength(1); // said once, not every check

    blocked = null; // the cap is lifted: the main connection is still down, so the backup opens
    await until(() => backup.subs.size === 1);
    expect(blind).toEqual([true, false]);

    blocked = "cap used up"; // the cap is reached while it is open: it closes, and the bot is blind again
    await until(() => status.some((m) => m === "[Helius] closing the backup: cap used up"));
    expect(blind).toEqual([true, false, true]);
    expect(redundant.backupUses).toBe(1);
  }, 15_000);
});
