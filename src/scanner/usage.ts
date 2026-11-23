export interface UsageReport {
  seconds: number;
  megabytes: number;
  /** The part of `megabytes` that Helius bills (all of it on a Helius stream, only the backup's on a free one). */
  meteredMegabytes: number;
  messages: number;
  rpcCalls: number;
  streamCredits: number;
  rpcCredits: number;
  creditsUsed: number;
  creditsPerMonth: number;
  freePlanCredits: number;
  fractionOfFreePlan: number;
}

/**
 * Tracks streamed bytes and RPC calls so we can project Helius credit use. WebSocket data costs 2 credits per
 * 0.1 MB (confirmed against the Helius dashboard); RPC calls are assumed to cost 1 credit each.
 */
export class UsageMeter {
  bytes = 0;
  meteredBytes = 0;
  messages = 0;
  rpcCalls = 0;
  private readonly startedAt: number;
  /**
   * `streamIsMetered` is false when the WebSocket comes from a provider other than Helius: the data is still
   * counted in MB, but it costs no Helius credits. Data from a Helius backup connection is added with `metered` true.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly streamIsMetered: boolean = true,
  ) {
    this.startedAt = now();
  }
  add(bytes: number, metered: boolean = this.streamIsMetered): void {
    this.bytes += bytes;
    if (metered) this.meteredBytes += bytes;
    this.messages++;
  }
  addRpc(n: number): void {
    this.rpcCalls += n;
  }
  report(freePlanCredits = 1_000_000): UsageReport {
    const seconds = Math.max(1, (this.now() - this.startedAt) / 1000);
    const megabytes = this.bytes / 1_000_000;
    const meteredMegabytes = this.meteredBytes / 1_000_000;
    const streamCredits = (meteredMegabytes / 0.1) * 2;
    const rpcCredits = this.rpcCalls;
    const creditsUsed = streamCredits + rpcCredits;
    const creditsPerMonth = (creditsUsed / seconds) * 30 * 24 * 3600;
    return {
      seconds,
      megabytes,
      meteredMegabytes,
      messages: this.messages,
      rpcCalls: this.rpcCalls,
      streamCredits,
      rpcCredits,
      creditsUsed,
      creditsPerMonth,
      freePlanCredits,
      fractionOfFreePlan: creditsPerMonth / freePlanCredits,
    };
  }
}
