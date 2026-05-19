# Schema & Storage

What's stored where, in what shape, with what semantics.

## Supabase tables

- **`positions`** — current holdings per user, written by `ibPricePoller` / `finnhubPricePoller`, read via Realtime by the FE. Includes:
  - Standard fields: `symbol`, `conid`, `shares`, `avg_cost`, `current_price`, `market_value`, `pnl`, `pnl_percent`, `vwap`, etc.
  - Zone-tracking: `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap` (see `signal-model.md` → Profit-Taking Zone Detection).
  - Source-tracking: `price_source` enum `'ib' | 'finnhub'`, `last_price_update_at` (see `architecture.md` → Multi-source price polling).

- **`analyses`** — one row per Analyze call. Holds the shared analysis context. Schema:
  ```
  {
    analysis_id uuid pk,
    user_id uuid,
    symbol text,
    conid bigint,
    indicator_snapshot jsonb,
    reasoning text,
    analyzed_at timestamptz,
    expires_at timestamptz
  }
  ```
  Lets multiple `signals` rows from the same analysis share context without duplication.

- **`signals`** — one row per *direction* of a unified analysis. Linked to its parent via `analysis_id`. A single unified analysis can produce 0, 1, or 2 signal rows (SELL, BUY, both, or one no-signal row). Each row carries:
  - `signal_type` (`'sell' | 'buy' | 'no_signal'`)
  - `signal_quality` (0-100)
  - `motivation` (per-type enum: SELL → `'take_profit' | 'derisk' | 'avoid_downside'`; BUY → `'pullback_entry' | 'breakout_continuation' | 'value'`; null for no_signal)
  - `price_range_low`, `price_range_high`
  - `optimal_price`
  - `rationale` — direction-specific reasoning bullet (the overall narrative is on `analyses.reasoning`)
  - Accuracy fields: `actual_max_since_analysis`, `actual_min_since_analysis`, `entered_range_at`, `exited_range_at`
  - `acted_on_at` (user marked "I acted on this")
  - `superseded_by_analysis_id` (FK to a newer `analyses.analysis_id`, not a newer signal — superseding is whole-analysis, not per-direction)
  
  Mutability rules in `signal-model.md` → Mutability rules.
  
  Index: `signals(user_id, symbol, analyzed_at desc)` for the "latest non-superseded" query.

- **`user_preferences`** — one row per user, keyed by Supabase user ID:
  - `sort_order`, `theme`, `llm_provider`
  - `signal_threshold` (generation-time minimum; distinct from Alerts feed's display filter)
  - `signal_min_market_value` (default 1000)
  - `suppressed_symbols` (text list)
  - `profit_zone_threshold_pct` (default 2.0)
  - `stat_config` (for the TickerDetail MarketStats panel customization — applies to all ticker screens)

- **`analysis_locks`** — concurrency control for signal analysis. Row per active analysis: `{ id, symbol, user_id, started_at, status: 'running' | 'failed' }`. 5-min TTL — `lockCleanup` cron deletes rows older than 5 min (assumed crashed). Realtime enabled.

- **`access_attempts`** — Google OAuth attempts (granted + non-whitelisted). `{ id, email, granted: bool, ip_address, user_agent, attempted_at }`. Audit trail for whitelist enforcement.

- **`contracts`** — per-conid metadata cache: `company_name`, `industry`, `category`, `currency`, `exchange`. Populated lazily on first signalEngine call for that conid; refreshed weekly.

- **`external_api_metrics`** — per-API-call instrumentation: `provider` ('ib' | 'finnhub'), endpoint/category, `duration_ms`, `retries`, status. 30-day TTL. Foundation for empirical perf tuning of both IB and Finnhub call patterns.

- **`app_config`** — key/value runtime config: `{ key text primary key, value text not null, updated_at timestamptz default now() }`. RLS: public `select` (anon + authenticated), service-role only for write. Realtime enabled. Currently holds `api_url` (current Cloudflare Quick Tunnel URL, written by the tunnel watcher; read by the FE on bootstrap and via Realtime subscription). See `architecture.md` → Public URL Discovery. Designed as a generic home for future runtime flags.

### Realtime publications

Enabled on: `positions`, `signals`, `analysis_locks`, `app_config`.

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
