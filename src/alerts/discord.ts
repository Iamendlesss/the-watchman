/** Discord's limit for one message's text. */
export const DISCORD_LIMIT = 2000;
const USERNAME = "Meme coin bot (paper)";
const HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

/**
 * True only for an https Discord webhook address. Anything else is refused, so a typo in .env can never send
 * alert text (or the webhook's own secret path) to some other host.
 */
export function isDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && HOSTS.has(u.hostname) && u.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

/**
 * Coin names and symbols are chosen by whoever launched the coin. Shown inside inline code they can't ping
 * anyone, add links or break the formatting. Control and text-direction characters are dropped.
 */
export function clean(s: string, max = 20): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "").replace(/`/g, "'").trim();
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
  return `\`${cut || "?"}\``;
}

export interface NotifierOptions {
  fetchFn?: typeof fetch;
  /** Gap kept between messages. Discord allows about 30 a minute per channel. */
  minIntervalMs?: number;
  /** One-line warnings for the console. They never contain the URL. */
  log?: (m: string) => void;
  /** Oldest messages are dropped beyond this many waiting. */
  maxQueue?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Told whether the message reached Discord (false if it was dropped, refused or never got through). */
export type Delivered = (delivered: boolean) => void;
interface Item {
  text: string;
  done?: Delivered;
}

/**
 * Sends text to a Discord webhook. `send` only queues, so it never slows or breaks the trading loop. A
 * background loop posts the queue in order, joining waiting messages into one post when they back up,
 * waits out rate limits (HTTP 429) and retries server errors. A webhook Discord rejects (deleted, wrong URL)
 * is not retried.
 */
export class DiscordNotifier {
  readonly enabled: boolean;
  sent = 0;
  failed = 0;
  dropped = 0;
  private readonly url: string;
  private readonly queue: Item[] = [];
  private draining: Promise<void> | null = null;
  private lastPostAt = 0;
  private lastWarnAt = -Infinity;

  constructor(url: string | undefined, private readonly o: NotifierOptions = {}) {
    this.url = (url ?? "").trim();
    this.enabled = this.url !== "" && isDiscordWebhook(this.url);
    if (this.url !== "" && !this.enabled) {
      o.log?.("Discord: DISCORD_WEBHOOK_URL is not a Discord webhook address (https://discord.com/api/webhooks/...), so alerts are off.");
    }
  }

  send(text: string, done?: Delivered): void {
    if (!this.enabled || !text) return done?.(false);
    this.queue.push({ text: text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text, done });
    while (this.queue.length > (this.o.maxQueue ?? 50)) {
      this.queue.shift()!.done?.(false);
      this.dropped++;
    }
    this.draining ??= this.drain().finally(() => (this.draining = null));
  }

  /** Wait until everything queued has been posted, or `timeoutMs` has passed. Used before the process exits. */
  async flush(timeoutMs = 5000): Promise<void> {
    if (!this.draining) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.draining, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const wait = this.lastPostAt + (this.o.minIntervalMs ?? 2100) - Date.now();
      if (wait > 0) await sleep(wait);
      const batch = [this.queue.shift()!];
      let content = batch[0]!.text;
      while (this.queue.length && content.length + 1 + this.queue[0]!.text.length <= DISCORD_LIMIT) {
        const next = this.queue.shift()!;
        content += `\n${next.text}`;
        batch.push(next);
      }
      const ok = await this.post(content);
      for (const item of batch) {
        try {
          item.done?.(ok);
        } catch {
          /* a caller's callback must never stop the queue */
        }
      }
    }
  }

  private async post(content: string): Promise<boolean> {
    const fetchFn = this.o.fetchFn ?? fetch;
    const body = JSON.stringify({ content, username: USERNAME, allowed_mentions: { parse: [] } });
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.lastPostAt = Date.now();
      try {
        const res = await fetchFn(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.sent++;
          return true;
        }
        if (res.status === 429) {
          const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
          await sleep(Math.min(60_000, Math.max(250, Number(info.retry_after ?? 2) * 1000)));
          continue;
        }
        if (res.status < 500) {
          this.fail(`Discord: the webhook refused the message (HTTP ${res.status}). Check DISCORD_WEBHOOK_URL in .env.`);
          return false;
        }
      } catch {
        /* network error or timeout: retried below */
      }
      if (attempt < 3) await sleep(1000 * attempt);
    }
    this.fail("Discord: could not be reached, so an alert was dropped.");
    return false;
  }

  /** Counted every time, printed at most every 10 minutes so an outage doesn't flood the console. */
  private fail(msg: string): void {
    this.failed++;
    if (Date.now() - this.lastWarnAt < 600_000) return;
    this.lastWarnAt = Date.now();
    this.o.log?.(msg);
  }
}
