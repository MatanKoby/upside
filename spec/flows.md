# Flows

End-to-end flows that thread across multiple components. Each one is a sequence — what triggers, what runs, what's persisted, what's notified.

## Signal Engine Flow (user-triggered, manual — single-direction playbook)

Two modes share this flow: **Fresh Analyze** and **Refine** (a follow-up on an active signal). See `signals/playbook.md` → Two Analyze modes.

1. **Pre-check**: re-analyze soft-block (last analysis within 5 min? → 429 with confirm prompt). Daily cost ceiling exceeded? → 429. Lock acquisition (`analysis_locks` row insert).
2. **Filter**: skip if held position with market value < threshold, or symbol suppressed.
3. **Direction**: held position → `sell`; not held → `buy`. (MVP is held-only → SELL.)
4. **Collect (fresh-or-stop)**: read canonical price from `positions.current_price` — gated on `last_price_update_at` recency, see `signals/playbook.md` → Freshness guard (no independent IB snapshot inside the engine). Fetch OHLCV bars from IB for the feature pack. If price is stale OR IB history returns empty → **stop gracefully here** with a `no_signal` row carrying the honest reason; no LLM call, never proceed on stale or missing data.
5. **Feature pack**: compute the precise level/volatility/trend/momentum/volume features locally (`technicals.ts`) — pivots, swing highs/lows, ATR, SMA/EMA, RSI, MACD, Bollinger, VWAP, relative volume. These are the LLM's grounding (it anchors legs to these levels, doesn't invent prices).
6. **Enrich**: news headlines + sentiment + insider + earnings from Finnhub (rate-limited queue).
7. **Context triggers**: read zone state; populate `contextualTriggers.inProfitTakingZone` if applicable (now wired into the prompt — Batch 14g).
8. **Refine only (14h)**: also attach the prior playbook + realized leg outcomes (from live tracking) + an anti-anchoring instruction.
9. **Synthesize**: send feature pack + context to the LLM for the chosen direction. Request a **playbook** (ordered legs, each with price/condition/confidence/reasoning) under one horizon, or `null` (no_signal).
10. **Validate**: Zod-parse (direction-specific motivation enum). On malformed: one stricter retry; second failure → `no_signal` row "LLM response malformed". Rate-limit/outage/bad-key → soft `no_signal` with honest reason.
11. **Store**: insert one `analyses` row (+ `refined_from_analysis_id` for a Refine) + **one** `signals` row (`signal_type` = direction or `no_signal`; leg[0] → `price_range_*`/`optimal_price`; full legs + horizon → `playbook jsonb`). Supersede prior non-superseded signals for the `(user, symbol)`. Release lock.
12. **Notify**: Realtime pushes the new signal → pill appears on TickerCard, playbook renders on TickerDetail. Live per-leg tracking (14h) then marks legs hit/missed as price moves.

## Profit-Taking Zone Flow (continuous, automated)

1. **Both pollers** (`ibPricePoller` and `finnhubPricePoller`) recompute zone state on every `positions` row write.
2. Compare `pnlPercent` to `user_preferences.profit_zone_threshold_pct`:
   - `!wasInZone && nowInZone` (transition into zone): set `zone_entered_at = now()`, `entered_zone_via_gap = (now() < todays_market_open)`. Check 4h cooldown on `last_zone_notification_at`; if outside cooldown, fire Discord notification to `#upside-zone-profit` (env `DISCORD_WEBHOOK_ZONE_PROFIT`), set `last_zone_notification_at = now()`.
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

## Watchlist Import Flow (manual, user-triggered)

1. User taps "Import from IB" on the Watchlist screen empty state, or "Re-import" in the gear settings.
2. FE POSTs `/api/watchlists/sync`.
3. Route requires IB `connected`; if not, returns `403 { reason: 'ib_required' }`.
4. api calls `GET /v1/api/iserver/watchlists` → list of all user_lists + system_lists.
5. **Filter to user_lists only** (Batch 13.2 captured the discriminator). For each user_list: `GET /v1/api/iserver/watchlist?id=<list_id>` → ticker payload.
6. Upsert `watchlist_lists` rows by `(user_id, ib_list_id)` — preserves any local `active` flag the user has already set. Newly-imported lists default to `active=false` (hidden).
7. Upsert `watchlist_items` for each ticker (`list_id`, `conid`, `symbol`). Removed-from-IB items get soft-deleted (rows kept for FK integrity; UI hides them).
8. Set `ib_modified_at` + `synced_at`. Realtime pushes the new state to the FE.
9. **Active-list conids get added to the polling loop** automatically (the pollers query `watchlist_lists WHERE active=true` on each cycle). No restart required.

## Marker Hit Flow (continuous, automated)

1. **`upsertQuote`** fires `checkMarkersForConid(conid, symbol, prevCanonical, currentPrice)` on every canonical price write. Markers are keyed by `(user_id, conid)` (migration 016) — one set per ticker, shared across every list it appears on.
2. For each marker (where `enabled = true`):
   - **Transition check** vs the prior write's price:
     - `at_or_below`: fires when `prev > price AND curr <= price`
     - `at_or_above`: fires when `prev < price AND curr >= price`
     - `about`: fires on entering a ±0.5·ATR band around `price`
   - **Cooldown gate**: if `now() − last_fired_at < cooldown_hours`, skip silently.
   - **Fire**: set `last_fired_at = now()`; call `notifyMarkerHit(marker, ticker)`.
3. Discord routing (first cut): `at_or_below` markers → `#upside-dip-buys` (`DISCORD_WEBHOOK_DIP_BUYS`). Other condition types accepted in schema; their alert channels queued for a follow-up.
4. Realtime pushes the updated marker (`last_fired_at`) to FE → row reflects "last fired 2m ago" state.

## Entry-Zone Update Flow (continuous, automated; Batch A+)

1. **Both pollers**, on each `quotes` write for an active-list conid, call `computeEntryZones(conid, currentPrice, bars, indicators, trendRegime)` — see `signals/entry-zones.md`.
2. Daily/intraday bars used by the function come from a per-conid cache (nightly refresh + on-demand if stale > 24h or first activation). The compute itself does NOT fetch bars per cycle.
3. **Upsert** `entry_zones` rows for `(conid, intraday|overnight|multiday)` with the new `price`, `reasoning`, `confidence`, `trend_regime`, `overbought_tightened`, `computed_at`.
4. **Discord alert**: if the current price crossed into a zone band that was published at the *prior* poll cycle, fire `notifyEntryZoneEnter(zone, ticker)` → `#upside-dip-buys` (first cut, shared with manual markers). Cooldown 24h anchored on `last_fired_at` per `(conid, horizon)`.
5. Realtime pushes the updated zones → FE entry-zone chips on the watchlist row update live.

## Intraday-Stats Update + Hit Flow (continuous-alert; nightly-compute; Batch B)

See `signals/stats.md` for the engine + Discord channel + math.

1. **Nightly cron** (`intradayStatsCron`, 24h cadence, IB-gated) iterates distinct active-list conids. Per conid: `ibHistory(conid, '2m', '5mins')` → `computeIntradayStats` → upsert `intraday_stats` row.
2. **`upsertQuote`** fires `checkIntradayStatsForConid(conid, symbol, prevCanonical, currentPrice)` on every canonical price write (alongside marker + entry-zone checks). The check is a no-op when `intraday_stats` has no row for the conid OR `quotes.today_open` is unset.
3. **Band** in price space: `band_top = today_open × (1 − p50/100)`, `band_bottom = today_open × (1 − p75/100)`. Fire condition: `prev > band_top AND curr ≤ band_top` (cross-into-band). Subsequent moves deeper do NOT re-fire.
4. **Cooldown** 24h anchored on `intraday_stats.last_fired_at`. Outside cooldown → `notifyIntradayStatsHit(...)` → `#upside-stats-alerts` (env `DISCORD_WEBHOOK_STATS_ALERTS`). Stamps `last_fired_at = now()`.
5. Realtime pushes updated `intraday_stats` + `quotes` → FE `IntradayStatsChip` on the watchlist row + `IntradayStatsPanel` on TickerDetail update live.

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
