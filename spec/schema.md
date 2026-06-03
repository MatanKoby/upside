# Schema & Storage

What's stored where, in what shape, with what semantics.

## Supabase tables

- **`positions`** — current holdings per user, written by `ibPricePoller` / `finnhubPricePoller`, read via Realtime by the FE. Includes:
  - Standard fields: `symbol`, `conid`, `shares`, `avg_cost`, `current_price`, `market_value`, `pnl`, `pnl_percent`, `vwap`, etc.
  - Zone-tracking: `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap` (see `signals/playbook.md` → Profit-Taking Zone Detection).
  - Source-tracking: `price_source` enum `'ib' | 'finnhub'`, `last_price_update_at` (see `architecture.md` → Multi-source price polling).
  - **`current_price` is the MVP canonical "latest quote"** for held symbols — see `architecture.md` → Single source of truth for current price. All consumers (header, chart price-line, Today's-Range, `signalEngine`) read it; no consumer re-fetches its own.

- **`quotes`** *(MVP via watchlist pivot; batch A1, extended A1-polish + B)* — canonical latest quote per instrument, keyed by conid. Stores **both** IB and Finnhub prices side-by-side (each with its own timestamp) so consumers can compare them, so divergence is visible (e.g. IB live $4.28 vs Finnhub prior-close $4.18 pre-market), and so fallback decisions can be made on real provenance rather than overwriting one with the other:
  ```
  { conid pk, symbol,
    ib_price       numeric, ib_updated_at       timestamptz,
    finnhub_price  numeric, finnhub_updated_at  timestamptz,
    canonical_price numeric, canonical_source 'ib'|'finnhub', canonical_updated_at timestamptz,
    today_change_pct numeric,                  -- (migration 015) for FE row %-change
    sparkline_closes numeric[],                -- (migration 015) trailing closes for the row sparkline
    today_open       numeric                   -- (migration 018) required by stats.md alert band
  }
  ```
  Each poller writes only its own source's columns; the `canonical_*` triple is the denormalized "the price to use" (IB-when-fresh-and-connected, Finnhub otherwise), set by whichever poller is currently authoritative. All three pollers also thread `today_open` (IB snapshot field `7295` / Finnhub `quote.o`) — see `signals/stats.md` for why. Promotes the MVP `positions.current_price` pattern to an instrument-keyed table so non-held symbols have prices too without duplicating a `price` column per surface. Written by the pollers (loop extended to cover held + watchlisted conids); read by every price surface and `signalEngine`. `positions.current_price` is preserved as a denormalized mirror of `canonical_price` (the same poller writes both) for MVP backward compatibility. Enforces the **price-is-an-instrument-property** principle.

- **`analyses`** — one row per Analyze call. Holds the shared analysis context. Schema:
  ```
  {
    analysis_id uuid pk,
    user_id uuid,
    symbol text,
    conid bigint,
    indicator_snapshot jsonb,            -- { values: featurePack, readings: indicatorAnalysis }
    reasoning text,
    analyzed_at timestamptz,
    expires_at timestamptz,
    refined_from_analysis_id uuid null   -- set by a Refine (14h); links to the analysis it revised
  }
  ```
  Lets the analysis's `signals` row share context without duplication. (Migration `010_playbook.sql` added `refined_from_analysis_id`.)

- **`signals`** — **one** row per analysis (single-direction playbook, Batch 14g — down from the 0-2 of the unified model). Linked to its parent via `analysis_id`. Direction is chosen by holding status (held → `sell`, not-held → `buy`). Each row carries:
  - `signal_type` (`'sell' | 'buy' | 'no_signal'`)
  - `signal_quality` (0-100 headline conviction)
  - `motivation` (per-type enum: SELL → `'take_profit' | 'derisk' | 'avoid_downside'`; BUY → `'pullback_entry' | 'breakout_continuation' | 'value'`; null for no_signal)
  - `price_range_low`, `price_range_high`, `optimal_price` — **leg[0]** (the immediate move) mapped onto these legacy columns (a half-ATR band around the leg price), so the deferred range-notifications + accuracy tracking keep working against the actionable price
  - `playbook jsonb` (Batch 14g) — the full ordered legs + horizon: `{ direction, signalQuality, motivation, horizon: 'intraday'|'multiday', horizonWindow, legs: [{ action, price, condition, confidence, reasoning, status?, actual? }] }`. Per-leg `status`/`actual` are written by 14h live tracking. Null on a no_signal row.
  - `rationale` — leg[0]'s reasoning bullet (the overall narrative is on `analyses.reasoning`)
  - Accuracy fields: `actual_max_since_analysis`, `actual_min_since_analysis`, `entered_range_at`, `exited_range_at`
  - `acted_on_at` (user marked "I acted on this")
  - `superseded_by_analysis_id` (FK to a newer `analyses.analysis_id` — superseding is whole-analysis)

  One signal per analysis makes supersede trivially clean. Mutability rules in `signals/playbook.md` → Mutability rules.

  Index: `signals(user_id, symbol, analyzed_at desc)` for the "latest non-superseded" query.

- **`user_preferences`** — one row per user, keyed by Supabase user ID:
  - `sort_order`, `theme`
  - (LLM provider/model is **not** here — it's app-level, in `app_config`. Keys are global, so the choice is global.)
  - `signal_threshold` (generation-time minimum; distinct from Alerts feed's display filter)
  - `signal_min_market_value` (default 1000)
  - `suppressed_symbols` (text list)
  - `profit_zone_threshold_pct` (default 2.0)
  - `stat_config` (for the TickerDetail MarketStats panel customization — applies to all ticker screens)

- **`analysis_locks`** — concurrency control for signal analysis. Row per active analysis: `{ id, symbol, user_id, started_at, status: 'running' | 'failed' }`. 5-min TTL — `lockCleanup` cron deletes rows older than 5 min (assumed crashed). Realtime enabled.

- **`access_attempts`** — Google OAuth attempts (granted + non-whitelisted). `{ id, email, granted: bool, ip_address, user_agent, attempted_at }`. Audit trail for whitelist enforcement.

- **`contracts`** — per-conid metadata cache: `company_name`, `industry`, `category`, `currency`, `exchange`. Populated lazily on first signalEngine call for that conid; refreshed weekly.

- **`external_api_metrics`** — per-API-call instrumentation: `provider` ('ib' | 'finnhub'), endpoint/category, `duration_ms`, `retries`, status. 30-day TTL. Foundation for empirical perf tuning of both IB and Finnhub call patterns.

- **`watchlist_lists`** *(MVP via watchlist pivot 2026-05-28; batch A1)* — one row per imported IB user-list per Upside user. `{ id pk, user_id uuid, ib_list_id text, name text, active bool default false, ib_modified_at timestamptz, synced_at timestamptz }`. `active=false` by default; user un-hides via the in-screen settings sheet (see `screens/watchlist.md`). System-lists from IB (`/iserver/watchlists` `system_lists`) are NOT imported — only `user_lists` (filter captured in Batch 13.2). Pollers iterate active lists only.

- **`watchlist_items`** *(MVP via watchlist pivot; batch A1)* — `{ id pk, list_id uuid FK, conid bigint, symbol text, added_at timestamptz }`. The same conid can appear on multiple lists (separate rows). The poller dedups by conid before writing to `quotes`. Held + watchlisted overlap is fine — both surfaces read the same canonical quote.

- **`watchlist_markers`** *(MVP via watchlist pivot; batch A2; re-keyed by migration 016)* — user-defined price targets. See `signals/markers.md`. `{ id pk, user_id uuid, conid bigint, label text null, price numeric, condition text check in ('at_or_above','at_or_below','about'), enabled bool default true, cooldown_hours int default 24, last_fired_at timestamptz null, created_at timestamptz, unique (user_id, conid, label, price, condition) }`. **Keyed by `(user_id, conid)` rather than `item_id`** — the original A2 schema attached markers to a specific `watchlist_items` row, but the same conid on two lists then had separate markers, which contradicts the user's mental model ("I'm tracking the stock, not the list-row"). Migration 016 re-keyed. Same condition vocabulary as playbook legs (see `signals/playbook.md` → schema note). First cut wires only `at_or_below` markers to `#upside-dip-buys`; others accepted in schema but their alert channels are queued.

- **`entry_zones`** *(MVP via watchlist pivot; batch A+)* — dynamic entry-zone engine state. See `signals/entry-zones.md`. `{ conid bigint, horizon text check in ('intraday','overnight','multiday'), price numeric, reasoning text, confidence int, trend_regime text, overbought_tightened bool, last_fired_at timestamptz null, computed_at timestamptz, primary key (conid, horizon) }`. Upserted on every poll cycle for active-list conids. Realtime enabled.

- **`intraday_stats`** *(MVP via watchlist pivot; batch B)* — nightly per-symbol stats from historical 5-min bars. See `signals/stats.md`. `{ conid bigint pk, symbol text, open_fade_pct_{mean,p50,p25}, close_fade_pct_{mean,p50,p25}, intraday_low_pct_{mean,p50,p75}, sample_size int, lookback_days int, last_fired_at timestamptz null, computed_at timestamptz }`. `last_fired_at` is the 24h cooldown anchor for the typical-intraday-low band alert. `symbol` mirrored on the row + indexed so TickerDetail can query by symbol without joining contracts. Realtime enabled.

- **`screener_jobs`** *(post-MVP screener track infrastructure; see `job-queue.md` for the full design)* — async work queue for all upstream-call processes (IB / Finnhub / compute). `{ id uuid pk, job_key text not null, action text not null, worker_pool text not null check in ('ib','finnhub','compute'), payload jsonb not null default '{}', status text not null default 'queued' check in ('queued','claimed','done','failed'), priority int not null default 0, scheduled_for timestamptz not null default now(), claimed_at timestamptz, claimed_by text, lease_expires_at timestamptz, attempts int not null default 0, last_error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz }`. **The partial unique index `create unique index on screener_jobs(job_key) where status in ('queued','claimed')`** is the dedup mechanism — producers `INSERT … ON CONFLICT DO NOTHING` to silently reject duplicates of in-flight work; done/failed rows don't conflict so tomorrow's same-work re-enqueue succeeds. Workers claim with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` to serialize concurrent claims. Producers own gating + retry policy; workers are pure executors. No Realtime publication (internal infra). Service-role-only writes.

- **`universe`** *(post-MVP screener track; see `signals/screener-universe.md` → Ring 1)* — one row per ticker that has ever entered the screener universe. Nightly Ring 1 filter pass writes/refreshes. `{ conid bigint pk, real_conid bigint null, symbol text, type text, mic text, last_filter_pass timestamptz, filter_result text check in ('in','out_price','out_cap','out_volume','no_data'), auto_promoted bool default false, last_price numeric, last_volume bigint, last_market_cap_m numeric, last_avg_volume integer, computed_at timestamptz }`. `last_volume` is yesterday's shares-traded count (Polygon grouped-daily, Batch S0.5); `last_avg_volume` is the 30-day median (weekly producer). **`conid` is a synthetic FNV-1a hash of `mic|symbol`** (negative-bigint) because Finnhub `/stock/symbol` is figi/cusip-keyed and doesn't carry IBKR conids — the synthetic PK keeps S1 cheap + idempotent. **`real_conid` is the IBKR conid** resolved lazily via `ibSecdefSearch` (S1.5); null until resolved. All cross-table joins to IB-keyed data (`intraday_stats`, `positions`, `watchlist_items`) use `real_conid`. **`auto_promoted`** is set when `catalyst_reversal` Stage-2 promotes a normally-filtered-out ticker into the day's curated list (see `signals/screener-universe.md` → catalyst_reversal). The `last_*` fields are cached for diagnosis. Stale rows (no `last_filter_pass` for 30 days) retention-cron'd.

- **`trait_scores`** *(post-MVP screener track; see `signals/screener-universe.md` → Traits)* — per `(conid, trait, asof_date)`. Rewritten each daily/intraday sweep; stale rows beyond shelf-life dropped. `{ conid bigint, trait text check in ('intraday_range_trader','catalyst_reversal','post_earnings_drift'), asof_date date, score numeric, payload jsonb, computed_at timestamptz, primary key (conid, trait, asof_date) }`. `payload` carries trait-specific FE-ready details (e.g. for `intraday_range_trader`: `{ p25, p50, p75, sample_size, today_open_band_low }`). Realtime enabled — the Screener tab subscribes to refresh row chips live.

- **`band_state`** *(post-MVP screener track; see `signals/band-engine.md`)* — per `(conid, session_date)`. The walking band-state machine's persistence. `{ conid bigint, session_date date, anchors jsonb, current_low_band numeric, current_high_band numeric, session_regime text check in ('mean_reversion','bullish_trend','bearish_trend','mixed','ah_low_confidence'), vol_scalar numeric, vol_regime_shift bool, band_touch_last_fired_at jsonb, updated_at timestamptz, primary key (conid, session_date) }`. `anchors` is a chronological array of `{kind:'low'|'high', price, ts}` for replay/debug. `band_touch_last_fired_at` is the per-band-kind 4h cooldown clock: `{ "low": <iso-ts | null>, "high": <iso-ts | null> }`. `leg_direction` (`'up'|'down'|null`) is implementation-internal state — derived from the most recent anchor at row reload time, not stored as its own column. Cleanly reset at 16:30 IDT next session — no AH carryover. Realtime enabled (band chips update live as the engine ticks).

- **`curated_list`** *(dip-bounce track; see `signals/curated-list.md`)* — auto-maintained pool of ~200-300 high-potential dip-bounce candidates, per session date. `{ conid bigint, asof_date date, rank int, intraday_range_trader_score numeric, avg_daily_volume bigint, daily_atr_pct numeric, computed_at timestamptz, primary key (conid, asof_date) }`. `conid` references `universe.real_conid`. Rewritten daily at 09:00 IDT (full) + incrementally at 15:30 IDT (pre-market admit/drop). Realtime enabled (Screener FE + Watchlist chips subscribe). Retention drops rows older than 7 days.

- **`signal_fires`** *(dip-bounce track; see `signals/dip-bounce-scorer.md`)* — every signal fire by any scorer (intraday + swing dip-bounce now, band-touches + marker hits once ported onto the same backbone). `{ id uuid pk, conid bigint, signal_kind text check in ('intraday_dip_bounce','swing_dip_bounce','band_touch_low','band_touch_high'), score numeric, components jsonb, horizon text, price_at_fire numeric, fire_ts timestamptz default now() }`. Index on `(signal_kind, fire_ts desc)` for hit-rate queries. The `components` jsonb carries the per-rule 0/1 breakdown so failures are diagnosable. Realtime NOT enabled (high churn; FE reads aggregated hit-rate, not individual fires).

- **`signal_outcomes`** *(dip-bounce track; see `signals/dip-bounce-scorer.md`)* — price snapshots at fixed offsets after each fire. `{ fire_id uuid references signal_fires(id) on delete cascade, t_offset text check in ('+30m','+2h','+1d','+3d'), snapshot_ts timestamptz, price numeric, return_pct numeric, primary key (fire_id, t_offset) }`. `signalOutcomesCron` looks up `quotes.canonical_price` at each due offset and writes the row; `return_pct = (price − signal_fires.price_at_fire) / signal_fires.price_at_fire × 100`. A SQL view `signal_hit_rate_30d` aggregates per `signal_kind`: `intraday_dip_bounce` reads `+2h` outcomes against +1% threshold; `swing_dip_bounce` reads `+3d` outcomes against +5%.

- **`app_config`** — key/value runtime config: `{ key text primary key, value text not null, updated_at timestamptz default now() }`. RLS: public `select` (anon + authenticated), service-role only for write. Realtime enabled. Generic home for app-level runtime flags. Current keys:
  - `api_url` — current Cloudflare Quick Tunnel URL, written by the tunnel watcher; read by the FE on bootstrap and via Realtime subscription. See `architecture.md` → Public URL Discovery.
  - `llm_provider` / `llm_model` — active LLM selection (app-level, since API keys are global), written by `POST /api/config/llm`, read by the signal engine per analysis and by the Settings picker via Realtime. Keys themselves stay in `.env` — only the choice is here. See `signals/playbook.md` → LLM Provider Abstraction.

### Realtime publications

Enabled on: `positions`, `signals`, `analysis_locks`, `app_config`. Watchlist-pivot tables also: `quotes`, `watchlist_lists`, `watchlist_items`, `watchlist_markers`, `entry_zones`, `intraday_stats`. Screener-track tables also: `trait_scores`, `band_state`. Dip-bounce track also: `curated_list` (Screener tab + Watchlist chips subscribe to all). `signal_fires` and `signal_outcomes` are NOT published — internal infra; FE reads aggregated hit-rate via the `signal_hit_rate_30d` view.

### Row Level Security

Enforced on every user-data table. Service role bypasses RLS for backend writes.

### Dropped tables

`position_history` — originally planned for daily snapshots. Removed because MTD comes from a Redis-cached month-start portfolio value, and accuracy tracking lives on the `signals` row itself. If post-MVP historical P&L charts ever need this, IB transactions API can rebuild the data on demand — no live retention required.

## Redis usage

Self-hosted in Docker container on Oracle VPS — no external service.

- **Daily LLM call counter**: key `llm_calls:YYYY-MM-DD`, midnight-UTC TTL. Incremented on every Analyze call. Hard-cap at `MAX_LLM_CALLS_PER_DAY` env var (default 50).
- **IB market data cache**: 5-15s TTL — prevents redundant IB calls within a polling interval.
- **Technicals cache**: keyed by `(conid, timeframe)`, TTL matches the analysis cadence — lets re-analysis within the cache window skip the recompute.
- **Portfolio value at month start**: key `portfolio_value_month_start`, set on first poll of each new month, NEVER overwritten until next month begins. Used for MTD fallback computation when IB account summary doesn't expose MTD directly.

Redis survives container restarts via volume mount.

## Finnhub Rate-Limited Queue

All Finnhub calls in the codebase route through `server/src/services/finnhubQueue.ts` — a fair scheduler that prevents rate-limit errors even under burst load.

### Design

- Token-bucket limiter at 50 calls/min globally (10-call buffer below Finnhub's 60/min free-tier ceiling). Configurable via env `FINNHUB_RATE_LIMIT_PER_MIN`.
- Each request declares a `category` (`quote`, `candle`, `news`, `insider`, `earnings`, `profile`, etc.) and a `key` (typically ticker symbol).
- **Per-category min-interval-per-key**: requests for the same `(category, key)` within the configured min-interval **wait for the next eligible slot** rather than firing immediately or returning cached data. No stale-cache returns — a waiting caller always gets fresh data when their request eventually fires. Worst-case wait equals the category's min-interval.
- FIFO ordering within a category; categories share the global token bucket.
- Exponential backoff + 1 retry on any 429 response (defensive — shouldn't happen given the buffer).
- Exposed API: `finnhubQueue.request<T>(category, key, fn: () => Promise<T>): Promise<T>`.

### Initial config (Batch 13.7)

All categories default to 0s min-interval (queue acts purely as a rate limiter, not a throttle).

### Tuned config (Batch 13.9, post-feature-implementation)

Per-category min-intervals set based on actual usage. Approximate initial values to refine empirically:
- `quote`: 60s per-key (fallback-only — when IB is on, this never fires)
- `candle`: 4h per-key (accuracy cron runs once daily)
- `news`: 15min per-key
- `insider`: 12h per-key
- `earnings`: 24h per-key
- `profile`: 7d per-key

## IB API Rate Limits

- Global: 10 requests/second via Client Portal API.
- Historical data: no hard limit for bars ≥1 min, but soft pacing — avoid >60 requests/10 min.
- With <10 positions, rate limits are not a concern in practice. Redis cache prevents redundant calls.
