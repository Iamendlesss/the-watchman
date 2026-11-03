# Solana Meme Coin Trader: Skill and Bot Spec (v0.2, for review)

Working name: `solana-memecoin-trader`. Nothing is built yet. This document is what gets built once you approve it or change it.

**What changed in v0.2 (after reading the Helius, Jupiter, DexScreener, and RugCheck docs):**

- Helius LaserStream gRPC is dropped (mainnet needs a $499/month plan). The launch feed uses the free-plan WebSocket instead.
- Helius Sender uses the SWQOS-only tier, because the fastest tier has a fixed 0.001 SOL minimum tip.
- Jupiter execution uses `/build` (raw instructions, no swap fee) plus Sender, not `/order` plus `/execute`.
- Every transaction is inspected before signing, because a remote API supplies the transaction data.
- RugCheck becomes a second-stage check only, because its unauthenticated rate limit is low.
- New section 5 lists the API stack and its limits.

## 1. Scope

**In scope**

- Solana only. Your own trading, from one dedicated wallet.
- Two strategies: sniping new launches, and trading trending/momentum coins.
- Fully autonomous execution in live mode, inside hard limits enforced in code.
- Discord alerts for launches, whale/watchlist activity, and every trade, plus daily P&L reports.
- Paper-trading mode (the default) and a one-week paper phase before any real money.

**Out of scope (for now)**

- Other chains, public callouts, copy-trading, leverage or perps, and any use of your main wallet.

## 2. How the pieces fit

The skill and the bot are two different things.

- **The bot** is TypeScript/Node code that runs on your computer. It makes every buy and sell decision with deterministic rules, because a model deciding each trade is too slow and can be steered by hype text.
- **The skill** (`SKILL.md`) tells Claude how to work with the bot: guide setup, review the ledger and decision logs, explain a coin using the same rules, run post-mortems on losses, and suggest parameter changes.

Rules for Claude inside the skill:

- Never ask for, accept, or repeat a private key or seed phrase in chat.
- Never change a risk limit on its own. Every change needs your explicit confirmation.
- Risk-limit increases take effect the next day only, so a bad day can't trigger a loosening.

```
solana-memecoin-trader/
  SKILL.md                 how Claude operates, reviews, and tunes the bot
  config/config.example.json
  src/
    scanner/               launch feed, trending feed, wallet watchlist
    safety/                the safety gate (hard-reject rules)
    strategy/              snipe.ts, momentum.ts, exits.ts
    executor/              paper.ts, live.ts (live behind flags)
    risk/                  limits, kill switch, reconciliation
    alerts/                Discord webhooks
    ledger/                SQLite trade records and reports
  tests/
  references/              rug patterns, checklists, API notes
```

## 3. Modules

### 3.1 Scanner

- **New launches:** a Helius LaserStream WebSocket `logsSubscribe` on the pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`), watching for the Create instruction and decoding the token details from the logs. Graduations to PumpSwap are watched through the PumpSwap AMM program (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). Both IDs get verified against pump.fun's published IDLs before building.
- **Data-usage guard:** the pump.fun stream includes every trade, and WebSocket data is metered against Helius credits. The bot tracks its own bytes received and logs it daily during paper trading. If usage would exceed the free plan, it falls back to DexScreener polling.
- **Trending/momentum:** DexScreener REST endpoints (60 requests per minute on the profile, boost, and meta endpoints).
- **Watchlist wallets:** Helius WebSocket account/log subscriptions on wallets you give me (not webhooks, which need a public URL). Whale buys and sells become alerts, and optionally a signal.
- The scanner sits behind an interface so the feed can be swapped later.
- API details change often, so each endpoint gets verified against current docs at build time.

### 3.2 Safety gate (every buy must pass)

Each rule is configurable, and any single hard-reject blocks the trade.

- **Token program checks:** for standard tokens, mint and freeze authority must be revoked. For Token-2022 tokens, reject transfer fees, permanent delegate, non-transferable, and transfer hooks.
- **Bonding-curve tokens:** the authority checks usually pass by design, so holder distribution, dev behavior, and bundling carry more weight.
- **Liquidity:** a minimum liquidity floor. For migrated pools, LP must be burned or locked.
- **Holders:** top-10 holders (excluding pool/curve) under a cap, no bundled-wallet clusters in the first blocks, and no dev-wallet dump.
- **Sellability:** a simulated sell must succeed, with price impact under the cap.
- **Extra signals:** creator history from your own ledger and a local blocklist of creators/tokens that burned you. RugCheck's token report is a second-stage check, run only on coins that already passed every rule above, because its unauthenticated rate limit is low (reported at about 15 requests per window; to be confirmed against its Swagger page).
- **Cost check:** skip if estimated round-trip cost (fees, tips, price impact) exceeds the cap.

### 3.3 Strategies

- **Snipe:** watch a new launch through a short observation window (a few minutes), then run the safety gate on real holder and dev data and enter only if it passes, with a small size. The bot does not race for first-block entry, since fees and speed put a small home-run bot at a disadvantage. Sniping is the riskier strategy, so it gets its own stats in reports.
- **Momentum:** trending coin with liquidity above a floor, healthy buy/sell ratio, and growing holders. It must not already be parabolic in the recent window (no chasing tops). Graduation from the bonding curve to a DEX pool is also a trigger, again subject to the safety gate. DexScreener boosts and ads are paid promotion, so they are never treated as a bullish signal.

### 3.4 Exits

- Recover the initial stake at 2x (sell enough to return cost basis), then trail a stop on the remainder.
- Hard stop-loss and a time stop (dead coins don't sit forever).
- Immediate exit on dev-dump, whale-dump, or liquidity-drop signals.

### 3.5 Executor

- Paper mode: same pipeline, simulated fills from real quotes with pessimistic slippage and fee assumptions. No key is loaded.
- Live mode: Jupiter Swap API v2 `/build` (raw swap instructions, Metis routing, no Jupiter swap fee), assembled into our own transaction and sent through Helius Sender on the SWQOS-only tier (0.000005 SOL minimum tip, plus a priority fee from the Helius Priority Fee API). Whether Jupiter routes bonding-curve tokens is unconfirmed, so a direct pump.fun instruction path is added only if needed.
- The free Jupiter plan allows about 1 request per second, so the bot requests a quote only right before a trade, never to poll prices.
- **Transaction verification before signing:** the bot decodes every transaction and refuses to sign unless every program is on the allowlist, the fee payer is the trading wallet, and there are no transfers to unknown accounts. This matters because a remote API supplies the instructions.
- Every transaction is also simulated before sending, with slippage, priority-fee, and tip caps, plus confirm/retry logic.
- **The bot has no "transfer out" code path at all.** It can only swap, through an allowlist of programs. A bug or a hostile token can't send your funds to another address.

### 3.6 Risk manager

- Position size, max open positions, daily loss halt, consecutive-loss pause, and a minimum SOL reserve for fees.
- The daily loss halt is measured against start-of-day equity (realized plus unrealized). After a halt, the bot stays off until you restart it manually.
- Kill switch: a local `STOP` file checked every cycle, plus clean shutdown on process signals.

### 3.7 Alerts and reports (Discord webhooks)

- Alerts: passing launches, watchlist/whale activity, position opened and closed (with breakdown), risk events and halts, heartbeat. Launch alerts are batched to respect webhook rate limits.
- Per-trade record: token, mint, strategy, entry/exit times, size, prices, fees, tips, slippage, P&L in SOL and USD, exit reason, and a snapshot of the safety-gate result.
- Daily/weekly report: win rate, average win vs. average loss, expectancy, fees as a share of gross P&L, best/worst trades, snipe vs. momentum breakdown, and what the gate rejected.

## 4. Starting parameters

These are starting values to be tuned from paper data. None of them has been validated.

| Parameter | Default |
| --- | --- |
| Position size | 3% of wallet equity |
| Max open positions | 4 |
| Daily loss halt | 35% of start-of-day equity |
| Hard stop-loss | 30% below entry |
| Initial recovery | at 2x |
| Trailing stop (remainder) | 25% below peak |
| Time stop | 30 min (snipe), 2 h (momentum) with no meaningful gain |
| Max slippage | 10% |
| Max round-trip cost | 6% of position |
| Top-10 holder cap | 35% (excluding pool/curve) |
| Consecutive-loss pause | 4 losses, 60 min cooldown |
| Minimum SOL reserve | 0.05 SOL |
| Helius Sender tier | SWQOS-only (0.000005 SOL minimum tip) |
| Jupiter quote rate | at most 1 request per second |

**Wallet-size note:** at the low end of your range, a 3% position is only a few dollars. Fixed costs (priority fees, tips) then eat a large share of every trade, and the round-trip cost cap will skip most trades. A wallet of a few hundred dollars or more, or a larger position percentage, works better. We can settle this in the paper phase.

## 5. API stack and limits

| Service | Used for | Plan / limits (from the docs) |
| --- | --- | --- |
| Helius | Launch and wallet streams (WebSocket), RPC, priority-fee estimates, Sender | Free plan: 1M credits per month, 10 RPC requests per second, standard WebSocket methods. WebSocket data costs 2 credits per 0.1 MB. Sender uses no credits but needs a tip. |
| Jupiter | Swap instructions via `/build` | Free API key from portal.jup.ag. Basic plan is about 1 request per second. |
| DexScreener | Pair data, trending metas, promotion streams | 60 requests per minute on the profile, boost, and meta endpoints. No key. |
| RugCheck | Second-stage token report | Low unauthenticated limit reported. Details to confirm from its Swagger page. |
| Discord | Alerts and reports | Webhook URL, with rate limits respected. |

Paid Helius tiers ($49 per month and up) would eat a large share of a $100 to $1,000 wallet, so the design stays on the free plan.

## 6. Running it on your own computer

- Run under a process supervisor (such as pm2) with auto-restart, and disable sleep.
- On every start, the bot reconciles the wallet against its ledger. Unknown positions are flagged, and no new trades open until reconciliation passes.
- An external heartbeat monitor pings you if the bot goes silent. Discord alone can't tell you the machine is down.
- If the machine loses power or internet, open positions are unmanaged. The low position cap and on-chain exit orders (where a venue supports them) limit the damage.

## 7. Security

- A brand-new wallet used only for this bot, funded in stages. Never your main wallet.
- The private key is loaded from a local environment variable or an encrypted keystore. It is never committed, logged, or pasted in chat.
- Minimal, pinned dependencies with a lockfile: a Solana SDK (`@solana/web3.js` or its successor, chosen at build time), an SPL token library, `ws`, `better-sqlite3`, `zod`, and a logger. Malicious npm packages and copied "sniper bot" repos are a common way Solana wallets get drained.
- The Discord webhook URL, Helius key, and Jupiter key live in your local `.env`, never in chat or in the skill files. The Helius key is part of the endpoint URL, so treat the whole URL as a secret.
- Every transaction is verified before signing (see section 3.5).

## 8. Modes and go-live criteria

1. **Paper (default):** one full week. The bot logs every decision, including rejections.
2. **Review:** together, we read the week's report, compare paper fills to reality, and fix bugs and parameters.
3. **Tiny live test:** a few very small real trades to check fees, slippage, and confirmation behavior against the paper model.
4. **Live with reduced limits** for the first days, then normal limits.

One week is a small sample. Use it to find bugs and bad assumptions, not as proof the strategy has an edge. If paper results are negative after fees, the right answer is to not go live.

## 9. Testing (what I can and can't do)

My sandbox can't reach Solana RPCs, Jupiter, DexScreener, or Discord, so I can only test against mocked and recorded data. That covers:

- Unit tests for each safety-gate rule using fixtures of known rug patterns.
- Tests that the risk manager can never exceed its caps.
- Replay of recorded launch data through paper mode.
- A `--dry-run` flag.

Everything that touches live APIs gets tested on your machine in paper mode.

## 10. Known risks

- Most meme coins go to zero, and you can lose the entire wallet.
- Sniping is a race against faster bots with better infrastructure. Free data feeds add latency.
- MEV/sandwich attacks, slippage, and failed transactions cost money even on good trades.
- Platform APIs change without notice and can break the bot.
- Software bugs are possible despite the caps.

## 11. Build phases

1. Scaffold, config validation, ledger, and paper executor.
2. Scanner and safety gate.
3. Strategies, exits, and risk manager.
4. Discord alerts and reports.
5. Live executor (behind flags) and reconciliation.
6. `SKILL.md`, docs, and tests. The deliverable is a downloadable folder.

## 12. What I need from you before building

- Approve or change the parameter table above.
- A free Helius API key, a free Jupiter API key, and a Discord webhook URL (keep all three in your local `.env`, not in chat).
- A screenshot of the RugCheck Swagger page showing the token report endpoint and any auth details.
- Any wallet addresses you want on the whale/watchlist (public addresses are fine to share).
- A decision on wallet size and position percentage, per the wallet-size note.