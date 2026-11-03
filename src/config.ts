import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const frac = (def: number) => z.number().gt(0).lt(1).default(def);

export const ConfigSchema = z
  .object({
    mode: z.enum(["paper", "live"]).default("paper"),
    wallet: z
      .object({
        // Starting equity for the paper wallet, in SOL. Set this to match the wallet you plan to fund.
        startingSol: z.number().positive().default(3),
        minSolReserve: z.number().nonnegative().default(0.05),
      })
      .default({}),
    sizing: z
      .object({
        positionPct: frac(0.03),
        maxOpenPositions: z.number().int().min(1).max(20).default(4),
      })
      .default({}),
    risk: z
      .object({
        dailyLossHaltPct: frac(0.35),
        // Overall drawdown floor (approved 2026-10-26): no new trades once equity is this far below its high-water
        // mark. Open positions keep their normal exits. Stays until `npm run resume`, which resets the mark.
        maxDrawdownPct: frac(0.3),
        hardStopLossPct: frac(0.25),
        maxSlippagePct: frac(0.1),
        maxRoundTripCostPct: frac(0.06),
        consecutiveLossPause: z
          .object({
            losses: z.number().int().min(1).default(4),
            cooldownMinutes: z.number().positive().default(60),
          })
          .default({}),
      })
      .default({}),
    exits: z
      .object({
        initialRecoveryMultiple: z.number().gt(1).default(2),
        trailingStopPct: frac(0.25),
        timeStopMinutes: z
          .object({
            snipe: z.number().positive().default(30),
            momentum: z.number().positive().default(120),
          })
          .default({}),
        // A coin that has not gained at least this much by its time stop is sold.
        timeStopMinGainPct: z.number().min(0).default(0.2),
        // After the stake is recovered, the remainder's full-exit target as a multiple of the recovery price
        // (so 2 means the remainder is sold in full once price is initialRecoveryMultiple x secondTargetMultiple
        // above entry -- 4x entry with the defaults below). Until it gets there, the trailing stop is the backstop.
        secondTargetMultiple: z.number().gt(1).default(2),
        // Sell everything if the creator has sold this share of what they bought after we entered.
        creatorDumpExitPct: frac(0.5),
      })
      .default({}),
    // Every number here is an unvalidated starting value. The scan and paper phases exist to tune them.
    safety: z
      .object({
        // Tightened from 0.35 after entry analysis of 256 paper trades: <15% top-10 concentration had a 9.7%
        // hard-stop rate vs 60-65% for 15-35%. A clean, monotonic signal.
        top10HolderCapPct: frac(0.15),
        maxCreatorHoldPct: frac(0.2),
        maxCreatorSoldPct: frac(0.25),
        maxBundledPct: frac(0.25),
        minUniqueBuyers: z.number().int().min(0).default(15),
        minBuySellRatio: z.number().min(0).default(1),
        // Raised from 4 after the same analysis: 25-50 SOL in the curve was the ONLY bucket (of 25 across 5
        // fields) with a positive average return (+8.1%). 10-25 was the worst bucket of all (-20.9% avg).
        minRealSol: z.number().min(0).default(20),
        // New: excludes coins already near the pump.fun graduation cap (observed ~85 SOL), which were
        // getting bought seconds before an automatic, fee-only force-sell on migration to a DEX pool.
        maxRealSol: z.number().positive().default(55),
        requireSolQuote: z.boolean().default(true),
        rejectMayhemMode: z.boolean().default(true),
        requireMintCheck: z.boolean().default(true),
        useRugcheck: z.boolean().default(true),
        rugcheckRequired: z.boolean().default(false),
      })
      .default({}),
    scanner: z
      .object({
        observationSeconds: z.number().positive().default(180),
        // Coins that show no traction by this point stop being streamed, which saves Helius credits.
        earlyCheckSeconds: z.number().positive().default(60),
        earlyMinBuyers: z.number().int().min(0).default(4),
        earlyMinSol: z.number().min(0).default(0.5),
        backfillMaxTxs: z.number().int().min(0).default(30),
        bundleSlots: z.number().int().min(0).default(2),
        maxTracked: z.number().int().positive().default(5000),
        heliusWsBase: z.string().default("wss://mainnet.helius-rpc.com"),
        heliusRpcBase: z.string().default("https://mainnet.helius-rpc.com"),
        stallSeconds: z.number().positive().default(60),
        // Parallel connections to STREAM_WS_URL. The free public RPC drops connections every minute or so, and drops
        // on separate connections are independent, so a second one covers the gaps. The Helius stream always uses 1,
        // because its data costs credits.
        streamConnections: z.number().int().min(1).max(4).default(2),
        // Delay between starting each of those connections, so they don't drop in step.
        streamStaggerSeconds: z.number().min(0).default(20),
        // The bot stops scanning for the day once it has used this many Helius credits (free plan: 1,000,000 a month).
        dailyCreditBudget: z.number().positive().default(30_000),
        rugchecksPerMinute: z.number().positive().default(8),
      })
      .default({}),
    fees: z
      .object({
        baseFeeSol: z.number().nonnegative().default(0.000005),
        priorityFeeSol: z.number().nonnegative().default(0.0005),
        senderTipSol: z.number().nonnegative().default(0.000005),
        // Rent deposit for a new token account. Paid on the first buy, returned when the position is fully closed.
        ataRentSol: z.number().nonnegative().default(0.00203928),
      })
      .default({}),
    paper: z
      .object({
        // Extra adverse slippage applied to every simulated fill, on top of the price-impact model.
        extraSlippagePct: z.number().min(0).lt(0.5).default(0.01),
        // Positions left open by an earlier run are closed at their last saved price minus this haircut.
        restartHaircutPct: z.number().min(0).lt(1).default(0.1),
        // Trade fee (protocol + creator) used when a coin has not reported one yet. Measured: 125 bps.
        defaultTradeFeePct: z.number().min(0).lt(0.2).default(0.0125),
      })
      .default({}),
    paths: z
      .object({
        dbPath: z.string().default("data/ledger.sqlite"),
        stopFile: z.string().default("STOP"),
      })
      .default({}),
    // Discord alerts and the daily report (phase 4). Nothing is sent unless DISCORD_WEBHOOK_URL is set in .env.
    alerts: z
      .object({
        enabled: z.boolean().default(true),
        // The daily report covers the previous UTC day. It goes out the first time the bot is running after this
        // hour (UTC), once per day.
        dailyReportHourUtc: z.number().int().min(0).max(23).default(7),
        // A "still running" message every this many hours. 0 turns it off.
        heartbeatHours: z.number().min(0).default(6),
        // A stream outage (no connection open) is reported once it has lasted this long.
        streamDownAlertSeconds: z.number().positive().default(60),
      })
      .default({}),
  })
  .refine((c) => c.wallet.minSolReserve < c.wallet.startingSol, {
    message: "wallet.minSolReserve must be smaller than wallet.startingSol",
    path: ["wallet", "minSolReserve"],
  });

export type Config = z.infer<typeof ConfigSchema>;

/** Parse and validate a config object. Live mode is refused in this build. */
export function parseConfig(raw: unknown): Config {
  const cfg = ConfigSchema.parse(raw ?? {});
  if (cfg.mode === "live") {
    throw new Error(
      "mode 'live' is not available in this build (phase 1 is paper-only). Set mode to 'paper'.",
    );
  }
  return cfg;
}

/** Load config/config.json if present, otherwise use the defaults. */
export function loadConfig(rootDir: string = process.cwd()): Config {
  const file = path.join(rootDir, "config", "config.json");
  if (!fs.existsSync(file)) return parseConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`config/config.json is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
