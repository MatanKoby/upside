# Flows

End-to-end flows that thread across multiple components. Each one is a sequence — what triggers, what runs, what's persisted, what's notified.

## Signal Engine Flow (user-triggered, manual)

1. **Pre-check**: re-analyze soft-block (last analysis within 5 min? → 429 with confirm prompt). Daily cost ceiling exceeded? → 429. Lock acquisition (`analysis_locks` row insert; see `signal-model.md` → Concurrency lock).
2. **Filter**: skip if held position with market value < threshold, or symbol explicitly suppressed.
3. **Collect**: Fetch OHLCV bars from IB Client Portal (Redis cache if fresh).
4. **Compute**: RSI, MACD, Bollinger, VWAP via `technicalindicators` library locally.
5. **Enrich**: News + sentiment + insider + earnings from Finnhub (through the rate-limited queue — see `schema.md`).
6. **Context triggers**: read position's zone state; populate `contextualTriggers.inProfitTakingZone` if applicable (see `signal-model.md` → Profit-Taking Zone Detection).
7. **Synthesize**: send structured indicator state + news context + contextualTriggers to LLM via the provider-agnostic abstraction. Request unified output (both SELL and BUY directions, each nullable).
8. **Validate**: Zod-parse LLM response. On malformed: retry once with stricter prompt. Second failure: persist `no_signal` row with reason "LLM response malformed".
9. **Store**: Insert one `analyses` row + 1-2 `signals` rows (one per non-null direction, or one `no_signal` row if both null). Update prior `signals` rows for the same `(user, symbol)` to set `supersededByAnalysisId`. Release lock.
10. **Notify**: Supabase Realtime pushes new signal(s) to FE → signal pill(s) appear on TickerCard and TickerDetail's SignalSection updates. Discord notification fires later when live price enters a signal's range (see "Signal-Range Entry Flow").

## Profit-Taking Zone Flow (continuous, automated)

1. **Both pollers** (`ibPricePoller` and `finnhubPricePoller`) recompute zone state on every `positions` row write.
2. Compare `pnlPercent` to `user_preferences.profit_zone_threshold_pct`:
   - `!wasInZone && nowInZone` (transition into zone): set `zone_entered_at = now()`, `entered_zone_via_gap = (now() < todays_market_open)`. Check 4h cooldown on `last_zone_notification_at`; if outside cooldown, fire Discord notification to `#upside-zones`, set `last_zone_notification_at = now()`.
   - `wasInZone && !nowInZone` (transition out of zone): set `zone_exited_at = now()`, clear `zone_entered_at`. No notification.
3. Supabase Realtime pushes updated position to FE → zone icon (and GAP badge if applicable) appears on card.
4. At end of regular session each day: clear `entered_zone_via_gap` for all positions (small daily cleanup task).

## Signal-Range Entry Flow (continuous, automated)

1. **Both pollers** check all open signals (`superseded_by_analysis_id IS NULL` AND not expired) for the position being written.
2. For each direction (SELL and BUY) independently:
   - If `current_price ∈ [priceRangeLow, priceRangeHigh]` and `enteredRangeAt IS NULL` (first crossing into range):
     - Set `enteredRangeAt = now()` on the signal row.
     - Fire Discord notification to the correct channel:
       - `signalType: 'sell'` → `#upside-signals-sell`
       - `signalType: 'buy'` → `#upside-signals-buy`
3. Cooldown not needed — range entry is a one-time event per signal row. Subsequent re-entries are recorded via accuracy tracking, not re-notified.

## Accuracy Cron Flow (daily, ~4:30 PM ET)

1. For each `signals` row where `superseded_by_analysis_id IS NULL` AND `analyzed_at` within last 30 days:
   - Fetch today's intraday candles (5-min or hourly bars) from Finnhub through the queue with `category: 'candle'`.
   - Update `actualMaxSinceAnalysis = max(prior, today_high)`.
   - Update `actualMinSinceAnalysis = min(prior, today_low)`.
   - Stamp `enteredRangeAt` if intraday price entered `[priceRangeLow, priceRangeHigh]` for the first time.
   - Stamp `exitedRangeAt` if price was in range and exited.
2. Independent of IB connection state — runs Finnhub-only.

## Connect / Disconnect Flow (IB session lifecycle)

**Connect** (when status is `stopped`):
1. User taps Connect in FE header status indicator.
2. FE POSTs `/api/auth/ib/connect`.
3. api uses Docker-socket access (dockerode) to issue `docker start` on the `ib-gateway` container.
4. IBeam boots (~10-15s) → drives headless-browser login at gateway's `localhost:5000` using credentials from `/run/secrets/`.
5. IBKR triggers 2FA push to user's IB Key phone app.
6. User approves push.
7. Gateway authenticated (~5s after approval).
8. FE polls `/api/auth/status` every ~3s → detects `connected` state.
9. `ibPricePoller` starts. Watchlist sync fires (post-Track-1).
10. Status indicator turns green.

**Disconnect** (when status is `connected`):
1. User taps Disconnect.
2. FE POSTs `/api/auth/ib/disconnect`.
3. api issues `docker stop` on `ib-gateway` container.
4. Container exits cleanly in 2-5s.
5. Status indicator turns gray (`stopped`).
6. `ibPricePoller` stops. `finnhubPricePoller` takes over.
7. IBKR Mobile is free to use.

**Nightly forced logout** (~11:45 PM ET): IBKR ends the session even if the container is still running. Next IB API call detects auth error → status indicator turns red (`session_expired`). User must Connect again.

**External session kill** (user logs into TWS directly elsewhere): same as nightly logout — next poll detects auth error.

## Data Flow — IB API → Backend

The Node.js app communicates with IB Client Portal Gateway via internal hostname `ib-gateway:5000`. Key endpoints used:

- `GET /portfolio/{accountId}/positions` — current positions
- `GET /portfolio/{accountId}/summary` — account summary (total value, P&L, MTD)
- `GET /iserver/marketdata/snapshot` — live quotes (price, VWAP, volume)
- `GET /iserver/marketdata/history` — historical bars for sparklines/charts/technicals
- `GET /portfolio/{accountId}/transactions` — for `tradingDaysHeld` (verify in Batch 13.5)
- `GET /portfolio/{accountId}/ledger` — P&L breakdown
- `POST /tickle` — session keepalive (every 30s)
- `POST /iserver/auth/ssodh/init` — re-initialize session after expiry

## Data Flow — Backend → Frontend

- REST API for initial data load (public URL discovered from `app_config.api_url` — see `architecture.md` → Public URL Discovery).
- Supabase Realtime for live updates: backend writes to Supabase → Supabase pushes change notification to client → client pulls updated data from Supabase (source of truth).
- PWA push notifications (Batch 16) as a separate alert channel when app is not open.

## Data Flow — Backend → Supabase

- Position data (latest state, written by both `ibPricePoller` and `finnhubPricePoller`)
- Analyses + signals (signal engine output)
- User preferences (sort order, thresholds, stat customization, suppressed symbols, profit-zone threshold)
- Auth (user session, JWT tokens via Supabase Auth)
- Runtime config (`app_config.api_url`)
- API call instrumentation (`external_api_metrics`)

## Data Flow — Backend → Redis

- Daily LLM call counter (`llm_calls:YYYY-MM-DD`, midnight-UTC TTL) for cost ceiling.
- Cache IB market data responses (TTL: 5-15s) to prevent redundant calls within polling interval.
- Cache computed technicals per position (TTL: matches analysis cadence).
- Portfolio-value-at-month-start cache for MTD fallback computation (set once per month, no TTL).
- Session-related data if needed.

## Data Flow — Backend → Finnhub

- All calls route through `finnhubQueue.request(category, key, fn)` — see `schema.md` → Finnhub Rate-Limited Queue.
- Categories: `quote` (fallback polling), `candle` (accuracy cron), `news`, `insider`, `earnings`, `profile`.
- Per-category min-intervals set in Batch 13.9 once usage patterns are known.
