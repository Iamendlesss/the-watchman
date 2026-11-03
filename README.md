# solana-meme-coin-trader (phase 4 of 6)

A paper-first Solana meme coin trading bot. **Nothing here can trade real money.** Phase 1 built the foundation
(config, ledger, risk manager, paper executor). Phase 2 adds a read-only launch scanner and the safety gate.

| Piece | File | What it does |
|---|---|---|
| Config | `src/config.ts` | Validated settings; approved defaults; refuses `live` mode |
| Ledger | `src/ledger.ts` | SQLite record of positions, fills, decisions, halts, daily equity |
| Risk manager | `src/risk.ts` | Sizing, position cap, drawdown floor, daily loss halt, loss-streak pause, SOL reserve, cost cap, STOP file |
| Paper executor | `src/executor.ts` | Simulated fills with price impact, slippage, fees, token-account rent |
| Engine | `src/engine.ts` | `tryOpen`: the only path to a new position |
| Event decoder | `src/scanner/borsh.ts`, `events.ts` | Decodes pump.fun events using the official IDL in `idl/pump.json` |
| Launch tracker | `src/scanner/tracker.ts` | Rebuilds holders, bundling, creator behavior from the trade stream |
| Stream | `src/scanner/ws.ts` | WebSocket carrying many subscriptions, with reconnect and stall watchdog; two parallel connections on the free stream |
| Backfill | `src/scanner/backfill.ts` | Recovers trades from before a coin's stream started |
| Addresses | `src/scanner/pda.ts` | Program derived addresses (mint-authority) |
| Safety gate | `src/safety/*` | Stage 1 stream rules, stage 2 mint check (RPC), stage 3 RugCheck |
| Scan command | `src/scan.ts` | Read-only scan with a verdict per launch and a data-usage report |
| Paper trader | `src/paper.ts` | Trades passing coins on paper using the risk manager and exit rules |
| Entry analysis | `src/analyze.ts` | Buckets closed trades by entry-time fields to find what predicts failure |
| Alerts | `src/alerts/*` | Discord webhook sender, alert texts, daily report, and when each one goes out |

Later phases: 3b momentum strategy (graduated/trending coins), 5 live executor, 6 skill + docs.

## Setup (Mac)

1. Node.js 22 or newer (`node -v`).
2. `cd ~/Documents/solana-meme-coin-trader`
3. `npm install`
4. `npm install-scripts approve esbuild` (once, if npm asks)
5. `cp config/config.example.json config/config.json` (paper wallet defaults to 3.75 SOL, about $300)
6. `npm run check-env` then `npm test`

## Paper trading (phase 3)

`npm run paper` runs the scan and trades the coins that pass the gate on paper (no real money, no keys):

- **Entry:** every coin that passes the safety gate is offered to the risk manager (3% of the wallet, max 4 open,
  35% daily loss halt, loss-streak pause, SOL reserve, round-trip cost cap). Everything it turns down is logged with the reason.
- **Fills:** simulated with pump.fun's own bonding-curve formula using the coin's live virtual reserves, the measured
  venue fee (protocol + creator, 1.25% per trade), network fees, token-account rent, and an extra 1% adverse slippage per leg.
- **Exits (in priority order):** graduation, creator dump (creator sold 50% of their buys), hard stop-loss (25% below
  entry, tightened from 30%: measured fee and slippage drag adds about 4 realized points on top of the configured
  trigger), recover the stake by selling half at 2x, then on the remainder: sell it all in full if price reaches the
  second target (`initialRecoveryMultiple x secondTargetMultiple`, 4x entry with the defaults), otherwise a 25%
  trailing stop on the remainder acts as the backstop, and a time stop (30 min without a 20% gain) applies before recovery.
- **Position checks run every 500ms** (down from 2s), so a stop-loss or trailing stop reacts closer to the moment it
  triggers instead of drifting further before the bot notices. This adds no RPC calls; price data already streams live.
- **Restarts:** positions left open by an earlier run are closed at their last saved price minus a 10% haircut and flagged.
- `npm run report` shows P&L, exits by reason, and why entries were turned down.

Run it as long as you like (`npm run paper`, stop with Ctrl+C) or for a set time (`npm run paper -- --minutes 120`).

**Cost reality:** at the paper wallet size a round trip costs about 5.5% to 6% of the position (about 2.5% venue fees,
about 2% assumed slippage, about 1% network fees), which sits right at the 6% cost cap. A coin has to gain roughly that
much just to break even. Below about 1 SOL of wallet the fixed costs make entries impossible under the cap.

## Discord alerts and the daily report (phase 4)

With `DISCORD_WEBHOOK_URL` set in `.env`, `npm run paper` posts to that Discord channel:

- Start and stop of the bot (Ctrl+C, closing the Terminal window, or `kill` all count as a clean stop).
- Every buy (with the gate numbers and a pump.fun link), partial sell and close (in percent of cost).
- Risk halts and pauses (daily loss halt, loss-streak pause, STOP file, low cash), each at most once an hour.
  Routine blocks like the cost cap are left to the daily report.
- A stream outage once no connection has been open for 60s, and when it ends.
- A heartbeat every 6 hours.
- The daily report for the previous UTC day, the first time the bot is running after 07:00 UTC.
  It is remembered in the ledger, so a restart doesn't send it twice.

Settings live under `alerts` in the config (`enabled`, `dailyReportHourUtc`, `heartbeatHours`,
`streamDownAlertSeconds`). Messages are sent in the background, so a slow or broken Discord never holds up
trading. Only `https://discord.com/api/webhooks/...` addresses are accepted, the address is never printed, and coin
names are shown as inline code with mentions switched off, so a coin called `@everyone` can't ping anyone.

Discord can't tell you the Mac itself has gone to sleep or lost power. If the heartbeat stops arriving, check the
Terminal window.

## Commands

- `npm run check-env`: verifies `.env` (never prints values).
- `npm run demo`: synthetic phase 1 walkthrough with made-up prices.
- `npm run scan -- --minutes 15`: read-only scan of live pump.fun launches. Add `--debug` to print every rejection and extra diagnostics.
- `npm run paper [-- --minutes N] [--debug]`: paper trading (see above).
- `npm run report [-- --since-hours N | --since 2026-09-28T00:00]`: P&L, exits by reason, and entries turned down.
  Every figure now also shows as a percent of cost, not just raw SOL -- raw SOL numbers drift as position size
  drifts with a shrinking or growing wallet, so they understate or overstate a change in real performance. Add
  `--since-hours N` or `--since <date-time>` to compare trades after that point against the all-time figures,
  e.g. to check whether a config change actually helped using the same running ledger.
- `npm run analyze`: buckets every closed trade by what its entry looked like (run-up since launch, top-10
  holder share, bundled-buy share, unique buyers, SOL in the curve) and shows win rate, average return, and
  hard-stop rate per bucket -- so a pattern in which KINDS of entries tend to fail shows up directly, using
  trades already collected. Buckets under 5 trades are flagged as too small to trust.
- `npm run discord-test`: sends one test message to check `DISCORD_WEBHOOK_URL`.
- `npm run daily-report [-- --day 2026-10-25] [--print]`: prints the daily report for a UTC day (yesterday by
  default) and sends it to Discord unless `--print` is given.
- `npm run status`: equity, the drawdown floor, halts, open positions and the loss streak.
- `npm run resume`: clears a halt. After a drawdown-floor halt it also restarts the high-water mark from today's
  equity, so the floor is 30% below that.

## Drawdown floor

No new trades once equity (open positions valued at what they would sell for) is `risk.maxDrawdownPct` (30%)
below its high-water mark, the highest equity since the floor was last reset. It is checked every half second,
sends a Discord alert, and stays until `npm run resume`. Open positions keep their normal exits. The mark started
at 1.3265 SOL on 2026-10-26, when the floor was switched on, so the floor then was 0.9286 SOL.
- `npm test`, `npm run typecheck`.

## What the scan does (credit-efficient design)

The first version streamed every pump.fun transaction and used about 143 MB in 10 minutes, roughly 12 million
Helius credits a month against 1 million on the free plan (confirmed on the Helius dashboard). This version
streams only what it needs:

1. **Launch stream:** one subscription on the pump.fun `mint-authority` account, which appears only in create
   transactions (address derived from the program id and checked against the standard Solana library).
2. **Launch-time rules:** non-SOL-quote coins and mayhem-mode coins are skipped immediately and never streamed.
3. **Per-coin streams:** every other coin gets its own subscription on its bonding curve.
4. **Early check** (`scanner.earlyCheckSeconds`, default 60s): coins with fewer than `earlyMinBuyers` buyers or
   less than `earlyMinSol` SOL in the curve are dropped and their subscription cancelled.
5. **Final judgement** (`scanner.observationSeconds`, default 180s): stage 1 stream rules. Only coins that pass
   are backfilled over RPC (the trades from the first slots, before the per-coin stream started, which is where
   bundled buys live), then stage 2 mint authority/freeze/Token-2022 extensions, then stage 3 RugCheck.
6. Every decision is logged to the ledger, and the report projects Helius credit use per month.

Every threshold is an unvalidated starting value in `config/config.json`.

## Entry filters tightened from analyze.ts (phase 3.6)

Running `npm run analyze` against 256 paper trades found two clean, data-backed signals:
- Top-10 holder concentration: <15% had a 9.7% hard-stop rate; 15-35% had 60-65%. `safety.top10HolderCapPct` is
  now 0.15, down from 0.35.
- Curve size at entry: 25-50 SOL was the only bucket (of 25 across 5 fields) with a positive average return
  (+8.1%); 10-25 SOL was the worst bucket of all (-20.9% avg). `safety.minRealSol` is now 20, up from 4, and a
  new `safety.maxRealSol` (default 55) excludes coins already near the pump.fun graduation cap -- these were
  being bought seconds before an automatic, fee-only force-sell on migration to a DEX pool.

Both remain unvalidated hypotheses until the next batch of paper trades confirms them under live conditions.

## Credit use, the budget guard, and other stream providers

Measured on live data: per-coin streams cost roughly 11 to 12 Helius credits per coin, because most of what the
stream delivers is failed bot transactions that cannot be filtered out on the free WebSocket. At that rate the free
plan's 1,000,000 credits cover about 3 hours of scanning per day.

- `scanner.dailyCreditBudget` (default 30,000): the scan records the credits it uses per UTC day and stops when
  the budget is spent. It also refuses to start if today's budget is already used.
- `STREAM_WS_URL` in `.env` (optional): take the live stream from another provider, for example the public Solana
  RPC `wss://api.mainnet-beta.solana.com`. It is used as given, your Helius key is never sent to it, and the stream
  then costs no Helius credits (Helius is only used for the few RPC calls). Public endpoints may throttle.
- `scanner.streamConnections` (default 2) and `scanner.streamStaggerSeconds` (default 20): with `STREAM_WS_URL` set,
  the bot opens this many connections, started this far apart, and counts each transaction once. The public RPC
  drops connections every 30-80s, and drops on separate connections are independent, so one covers the other's
  gap. The status line shows `stream drops N (blind Ns)`, where blind means no connection was open. The Helius
  stream always uses one connection, because its data costs credits.

## Safety notes

- `.env` and `data/` are git-ignored. Never share `.env`. The scan prints no keys and no endpoint URLs.
- The paper executor and the gate thresholds are models and guesses. The paper week tunes them.
- `idl/pump.json` is copied from github.com/pump-fun/pump-public-docs (commit 81091419). Re-copy it if pump.fun changes its events.
- Trades during a WebSocket outage are not recovered (only the launch-time gap is backfilled).
## Safety notes

- `.env` and `data/` are git-ignored. Never share `.env`. The scan prints no keys and no endpoint URLs.
- The paper executor and the gate thresholds are models and guesses. The paper week tunes them.
- `idl/pump.json` is copied from github.com/pump-fun/pump-public-docs (commit 81091419). Re-copy it if pump.fun changes its events.
