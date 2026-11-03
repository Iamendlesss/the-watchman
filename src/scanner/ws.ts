export type LogHandler = (slot: number, logs: string[], signature: string) => void;

export interface LogStreamOptions {
  url: string;
  onBytes?: (n: number) => void;
  /** Human-readable status lines. Never contains the URL, because the URL holds the API key. */
  onStatus?: (msg: string) => void;
  /** Called when the server confirms a subscription (again after every reconnect). */
  onSubscribed?: (id: string) => void;
  /** Called with true when the socket opens, and with false when an open socket closes (not on stop()). */
  onConnectionChange?: (open: boolean) => void;
  stallMs?: number;
  /** Injectable for tests. */
  WebSocketCtor?: typeof WebSocket;
}

interface Sub {
  address: string;
  handler: LogHandler;
  reqId: number | null;
  subId: number | null;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: { code?: number };
  method?: string;
  params?: {
    subscription?: number;
    result?: { context?: { slot?: number }; value?: { signature?: string; err?: unknown; logs?: string[] } };
  };
}

const OPEN = 1;

/**
 * One WebSocket carrying many `logsSubscribe` subscriptions, each keyed by a local id. It reconnects with
 * backoff and re-creates every subscription, and drops failed transactions. A connection that stays open but
 * goes silent for `stallMs` (or never finishes opening) is abandoned and replaced at once: waiting for a dead
 * socket to close can take several more seconds, and anything it sends afterwards is ignored.
 */
export class LogStream {
  private ws: WebSocket | null = null;
  private isOpen = false;
  private stopped = false;
  private attempt = 0;
  private lastMessageAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextReq = 1;
  private readonly subs = new Map<string, Sub>();
  private readonly byReq = new Map<number, string>();
  private readonly bySubId = new Map<number, string>();
  private readonly cancelled = new Set<number>();
  reconnects = 0;
  /** Notifications for failed transactions (mostly bot spam). They are received and paid for, then dropped. */
  failedDropped = 0;
  notifications = 0;

  constructor(private readonly o: LogStreamOptions) {}

  get activeSubscriptions(): number {
    return this.subs.size;
  }

  start(): void {
    this.stopped = false;
    this.connect();
    const stall = this.o.stallMs ?? 60_000;
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastMessageAt > stall) {
        this.o.onStatus?.(`no data for ${Math.round(stall / 1000)}s; replacing the connection`);
        this.replaceStalled();
      }
    }, Math.max(50, Math.min(5000, stall / 2)));
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /** Watch transactions that mention `address`. Safe to call before the socket is open; safe to repeat. */
  subscribe(id: string, address: string, handler: LogHandler): void {
    if (this.subs.has(id)) return;
    const sub: Sub = { address, handler, reqId: null, subId: null };
    this.subs.set(id, sub);
    this.sendSubscribe(id, sub);
  }

  unsubscribe(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    if (sub.subId !== null) {
      this.bySubId.delete(sub.subId);
      this.send({ id: this.nextReq++, method: "logsUnsubscribe", params: [sub.subId] });
    } else if (sub.reqId !== null) {
      this.cancelled.add(sub.reqId); // still waiting for the server's answer; cancel when it arrives
    }
  }

  private send(obj: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", ...obj }));
    return true;
  }

  private sendSubscribe(id: string, sub: Sub): void {
    if (!this.ws || this.ws.readyState !== OPEN) return; // it will be sent when the socket opens
    const reqId = this.nextReq++;
    sub.reqId = reqId;
    sub.subId = null;
    this.byReq.set(reqId, id);
    this.send({ id: reqId, method: "logsSubscribe", params: [{ mentions: [sub.address] }, { commitment: "confirmed" }] });
  }

  /** Drop a silent socket without waiting for it to close, and connect a new one straight away. */
  private replaceStalled(): void {
    const dead = this.ws;
    this.ws = null; // from here on, its events are ignored
    try {
      dead?.close();
    } catch {
      /* already closing */
    }
    this.reconnects++;
    this.markClosed();
    this.connect();
  }

  private markClosed(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.o.onConnectionChange?.(false);
  }

  private connect(): void {
    const Ctor = this.o.WebSocketCtor ?? globalThis.WebSocket;
    if (!Ctor) throw new Error("This Node.js has no built-in WebSocket. Use Node 22 or newer.");
    const ws = new Ctor(this.o.url);
    this.ws = ws;
    this.lastMessageAt = Date.now();
    const current = () => this.ws === ws; // false once this socket has been replaced
    ws.addEventListener("open", () => {
      if (!current()) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.byReq.clear();
      this.bySubId.clear();
      this.cancelled.clear();
      this.o.onStatus?.(`connected; creating ${this.subs.size} subscription(s)`);
      this.isOpen = true;
      this.o.onConnectionChange?.(true);
      for (const [id, sub] of this.subs) this.sendSubscribe(id, sub);
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      if (!current()) return; // a replaced socket's subscription ids no longer mean anything
      this.lastMessageAt = Date.now();
      const text = typeof ev.data === "string" ? ev.data : String(ev.data);
      this.o.onBytes?.(Buffer.byteLength(text));
      let msg: RpcMessage;
      try {
        msg = JSON.parse(text) as RpcMessage;
      } catch {
        return;
      }
      if (typeof msg.id === "number" && this.byReq.has(msg.id)) {
        this.onSubscribeReply(msg);
        return;
      }
      if (msg.method !== "logsNotification") return;
      const localId = this.bySubId.get(msg.params?.subscription ?? -1);
      const sub = localId ? this.subs.get(localId) : undefined;
      const res = msg.params?.result;
      const v = res?.value;
      this.notifications++;
      if (v?.err) this.failedDropped++;
      if (!sub || !v || v.err || !Array.isArray(v.logs)) return;
      sub.handler(res?.context?.slot ?? 0, v.logs, v.signature ?? "");
    });
    ws.addEventListener("error", () => {
      if (current()) this.o.onStatus?.("socket error");
    });
    ws.addEventListener("close", (ev: { code: number }) => {
      if (this.stopped || !current()) return;
      this.ws = null; // nothing to watch while waiting to reconnect
      this.reconnects++;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt++) + Math.random() * 500;
      // 1006 means the other side hung up without a close frame (the public RPC does this every minute or so).
      this.o.onStatus?.(`disconnected (code ${ev.code}); reconnecting in ${(delay / 1000).toFixed(1)}s`);
      this.markClosed();
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private onSubscribeReply(msg: RpcMessage): void {
    const reqId = msg.id as number;
    const localId = this.byReq.get(reqId)!;
    this.byReq.delete(reqId);
    const subId = typeof msg.result === "number" ? msg.result : null;
    if (this.cancelled.delete(reqId)) {
      if (subId !== null) this.send({ id: this.nextReq++, method: "logsUnsubscribe", params: [subId] });
      return;
    }
    const sub = this.subs.get(localId);
    if (subId === null) {
      this.o.onStatus?.(`subscription rejected by server (code ${msg.error?.code ?? "unknown"})`);
      return;
    }
    if (!sub) {
      this.send({ id: this.nextReq++, method: "logsUnsubscribe", params: [subId] });
      return;
    }
    sub.subId = subId;
    this.bySubId.set(subId, localId);
    this.o.onSubscribed?.(localId);
  }
}

export interface RedundantLogStreamOptions extends Omit<LogStreamOptions, "onSubscribed" | "onConnectionChange"> {
  /** Parallel connections to the same URL. Each carries every subscription. */
  connections: number;
  /** Delay between starting each connection, so they don't connect (and get dropped) in step. */
  staggerMs?: number;
  /** Called when a connection's server confirms a subscription. `label` is "[A] ", "[B] ", ... or "" with one connection. */
  onSubscribed?: (id: string, label: string) => void;
  /** Called with true when the last open connection closes, and with false when one opens again. */
  onBlindChange?: (blind: boolean) => void;
}

/**
 * Several LogStreams to the same URL, each carrying every subscription. The free public RPC drops connections
 * every 30-80s (seen 2026-10-21, close code 1006), and each drop costs 5-10s of data. Drops on separate
 * connections were independent, so while one reconnects another keeps data flowing. A transaction that arrives
 * on more than one connection is handed to its handler once.
 */
export class RedundantLogStream {
  private readonly streams: LogStream[];
  private readonly ids = new Set<string>();
  // Two generations of "already delivered" keys, rotated every minute, so the memory stays bounded.
  private seen = new Set<string>();
  private seenBefore = new Set<string>();
  private rotateTimer: ReturnType<typeof setInterval> | null = null;
  private readonly startTimers: ReturnType<typeof setTimeout>[] = [];
  private openCount = 0;
  private blindSince: number | null = null;
  private blindTotal = 0;
  /** Notifications already delivered by another connection. */
  duplicatesDropped = 0;

  constructor(private readonly o: RedundantLogStreamOptions) {
    const n = Math.max(1, Math.floor(o.connections));
    this.streams = Array.from({ length: n }, (_, i) => {
      const label = n > 1 ? `[${String.fromCharCode(65 + i)}] ` : "";
      return new LogStream({
        url: o.url,
        stallMs: o.stallMs,
        WebSocketCtor: o.WebSocketCtor,
        onBytes: o.onBytes,
        onStatus: (m) => o.onStatus?.(`${label}${m}`),
        onSubscribed: (id) => o.onSubscribed?.(id, label),
        onConnectionChange: (open) => this.onConnectionChange(open),
      });
    });
  }

  get connections(): number {
    return this.streams.length;
  }

  get activeSubscriptions(): number {
    return this.ids.size;
  }

  get reconnects(): number {
    return this.streams.reduce((a, s) => a + s.reconnects, 0);
  }

  get notifications(): number {
    return this.streams.reduce((a, s) => a + s.notifications, 0);
  }

  get failedDropped(): number {
    return this.streams.reduce((a, s) => a + s.failedDropped, 0);
  }

  /** Milliseconds, after the first connection opened, during which no connection was open. */
  get blindMs(): number {
    return this.blindTotal + (this.blindSince === null ? 0 : Date.now() - this.blindSince);
  }

  start(): void {
    this.rotateTimer = setInterval(() => {
      this.seenBefore = this.seen;
      this.seen = new Set();
    }, 60_000);
    this.streams.forEach((s, i) => {
      if (i === 0) s.start();
      else this.startTimers.push(setTimeout(() => s.start(), i * (this.o.staggerMs ?? 20_000)));
    });
  }

  stop(): void {
    this.startTimers.forEach(clearTimeout);
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    if (this.blindSince !== null) {
      this.blindTotal += Date.now() - this.blindSince;
      this.blindSince = null;
    }
    for (const s of this.streams) s.stop();
  }

  /** Watch transactions that mention `address`, on every connection. Safe to repeat. */
  subscribe(id: string, address: string, handler: LogHandler): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    if (this.streams.length === 1) return this.streams[0]!.subscribe(id, address, handler); // nothing to deduplicate
    const once: LogHandler = (slot, logs, signature) => {
      if (signature) {
        const key = `${id} ${signature}`;
        if (this.seen.has(key) || this.seenBefore.has(key)) {
          this.duplicatesDropped++;
          return;
        }
        this.seen.add(key);
      }
      handler(slot, logs, signature);
    };
    for (const s of this.streams) s.subscribe(id, address, once);
  }

  unsubscribe(id: string): void {
    if (!this.ids.delete(id)) return;
    for (const s of this.streams) s.unsubscribe(id);
  }

  private onConnectionChange(open: boolean): void {
    const now = Date.now();
    if (open) {
      if (this.openCount === 0 && this.blindSince !== null) {
        const gap = now - this.blindSince;
        this.blindTotal += gap;
        this.blindSince = null;
        if (this.streams.length > 1) this.o.onStatus?.(`a connection is back after ${(gap / 1000).toFixed(1)}s with none open`);
        this.o.onBlindChange?.(false);
      }
      this.openCount++;
      return;
    }
    this.openCount--;
    if (this.openCount === 0) {
      this.blindSince = now;
      if (this.streams.length > 1) this.o.onStatus?.("all connections are down; no data until one reconnects");
      this.o.onBlindChange?.(true);
    }
  }
}
