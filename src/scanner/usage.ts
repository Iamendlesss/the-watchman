export interface UsageReport {
  seconds: number;
  megabytes: number;
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
  messages = 0;
  rpcCalls = 0;
  private readonly startedAt: number;
  /**
   * `streamIsMetered` is false when the WebSocket comes from a provider other than Helius: the data is still
   * counted in MB, but it costs no Helius credits.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly streamIsMetered: boolean = true,
  ) {
    this.startedAt = now();
  }
  add(bytes: number): void {
    this.bytes += bytes;
    this.messages++;
  }
  addRpc(n: number): void {
    this.rpcCalls += n;
  }
  report(freePlanCredits = 1_000_000): UsageReport {
    const seconds = Math.max(1, (this.now() - this.startedAt) / 1000);
    const megabytes = this.bytes / 1_000_000;
    const streamCredits = this.streamIsMetered ? (megabytes / 0.1) * 2 : 0;
    const rpcCredits = this.rpcCalls;
    const creditsUsed = streamCredits + rpcCredits;
    const creditsPerMonth = (creditsUsed / seconds) * 30 * 24 * 3600;
    return {
      seconds,
      megabytes,
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
