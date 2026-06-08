# Schema & Storage

What's stored where, in what shape, with what semantics.

## Supabase tables

- **`positions`** — current holdings per user, written by `ibPricePoller` / `finnhubPricePoller`, read via Realtime by the FE. **Holding facts only (Batch X5 — no price or price-derived column).** Includes:
  - Holding fields: `symbol`, `conid`, `shares`, `avg_cost`, `realized_pnl`, `vwap_value`/`vwap_updated_at`, `trading_days_held`, `currency`, `asset_class`, `industry`, `category`, `first_seen_at`/`first_seen_source`.
  - Zone-tracking: `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap` (see `signals/playbook.md` → Profit-Taking Zone Detection).
  - Source-tracking: `price_source` enum `'ib' | 'finnhub'`, `last_price_update_at` (see `architecture.md` → Multi-source price polling).
  - **Price + P&L are NOT stored here.** `migration 030` dropped `current_price`, `market_value`, `unrealized_pnl[_pct]`, `today_change[_pct]`, `daily_return`, `portfolio_weight`, `portfolio_contribution`. The canonical price lives in **`quotes`** (keyed by conid); market value + unrealized P&L + weight are **recomputed** from `quotes.canonical_price × shares` by every reader (the FE `usePositions`/`useTickerDetail`, the server `routes/portfolio` `/summary` + `signalEngine`). See `architecture.md` → Single source of truth for current price.

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
  Each poller writes only its own source's columns; the `canonical_*` triple is the denormalized "the price to use" (IB-when-fresh-and-connected, Finnhub otherwise), set by whichever poller is currently authoritative. All three pollers also thread `today_open` (IB snapshot field `7295` / Finnhub `quote.o`) — see `signals/stats.md` for why. Promotes the MVP `positions.current_price` pattern to an instrument-keyed table so non-held symbols have prices too without duplicating a `price` column per surface. Written by the pollers (loop covers held ∪ active-watchlist conids); read by **every** price surface (position cards, watchlist rows, TickerDetail, chart, sparkline), the portfolio summary, `signalEngine`, and `riskFlagsCron`. **Batch X5:** this is the single price home — `positions` no longer mirrors `canonical_price` (the old `positions.current_price` was dropped). Market value + unrealized P&L are recomputed from `canonical_price × shares` by readers, never stored. Enforces the **price-is-an-instrument-property** principle.

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
  - `risk_flag_config` (jsonb — tunable risk-flag thresholds: surge `x_pct`/`n_sessions`, `vol_mult`, `rsi_z`, `near_high_w_pct`, `micro_cap_usd`, `earnings_d_days`; defaults seeded by calibration — see `signals/risk-flags.md` + `screens/settings.md`)

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

- **`universe`** *(post-MVP screener track; see `signals/screener-universe.md` → Ring 1)* — one row per ticker that has ever entered the screener universe. Nightly Ring 1 filter pass writes/refreshes. `{ conid bigint pk, real_conid bigint null, symbol text, type text, mic text, last_filter_pass timestamptz, filter_result text check in ('in','out_price','out_cap','out_volume','no_data'), auto_promoted bool default false, last_price numeric, last_volume bigint, last_market_cap_m numeric, last_avg_volume bigint, computed_at timestamptz }`. `last_volume` is the most-recent trading day's shares-traded count (Polygon grouped-daily, Batch S0.5); `last_avg_volume` is the 30-day median daily volume derived from `daily_bars` (`refresh_universe_avg_volume`, Batch X4 — widened from `integer` to `bigint` since high-volume sub-dollar names overflow int). **`conid` is a synthetic FNV-1a hash of `mic|symbol`** (negative-bigint) because Finnhub `/stock/symbol` is figi/cusip-keyed and doesn't carry IBKR conids — the synthetic PK keeps S1 cheap + idempotent. **`real_conid` is the IBKR conid** resolved lazily via `ibSecdefSearch` (S1.5); null until resolved. All cross-table joins to IB-keyed data (`intraday_stats`, `positions`, `watchlist_items`) use `real_conid`. **`auto_promoted`** is set when `catalyst_reversal` Stage-2 promotes a normally-filtered-out ticker into the day's curated list (see `signals/screener-universe.md` → catalyst_reversal). The `last_*` fields are cached for diagnosis. Stale rows (no `last_filter_pass` for 30 days) retention-cron'd.

- **`daily_bars`** *(daily-grain SSOT; Batch X4; see `data/sources.md` → daily_bars)* — daily OHLCV bars, the **one** home for daily-grain price/volume. `{ conid bigint, date date, o numeric, h numeric, l numeric, c numeric, v bigint, source text default 'polygon', computed_at timestamptz, primary key (conid, date) }`. `conid` is `universe.real_conid` (the IB conid; same key as `curated_list` / `trait_scores`). Written by `universeQuoteProducer` from **Polygon grouped-daily** (one call → the whole US universe for a date; weekend-safe) — the most-recent weekday's bar appended each run + a 30-day bootstrap on gaps; Yahoo v8/chart gap-fills the long tail Polygon misses (`source='yahoo'`). ~45-day retention. Daily bars are the only data type with no non-IB fallback before this table, so it exists to keep the daily-grain consumers (the curated-list cron's ATR%+ADV gates, the swing dip-bounce feature pack, the TickerDetail sparkline) alive when IB history 503s. NOT published to Realtime (high churn; every consumer reads server-side). The 30-day median per conid feeds `universe.last_avg_volume` via `refresh_universe_avg_volume()`. Index on `(date)` for the producer's coverage check + retention. **IB stays the source for intraday 5-min bars + live snapshots** (Polygon free is daily-only) — see `data/sources.md` → S0.5 decision matrix.

- **`trait_scores`** *(post-MVP screener track; see `signals/screener-universe.md` → Traits)* — per `(conid, trait, asof_date)`. Rewritten each daily/intraday sweep; stale rows beyond shelf-life dropped. `{ conid bigint, trait text check in ('intraday_range_trader','catalyst_reversal','post_earnings_drift'), asof_date date, score numeric, payload jsonb, computed_at timestamptz, primary key (conid, trait, asof_date) }`. `payload` carries trait-specific FE-ready details (e.g. for `intraday_range_trader`: `{ p25, p50, p75, sample_size, today_open_band_low }`). Realtime enabled — the Screener tab subscribes to refresh row chips live.

- **`band_state`** *(post-MVP screener track; see `signals/band-engine.md`)* — per `(conid, session_date)`. The walking band-state machine's persistence. `{ conid bigint, session_date date, anchors jsonb, current_low_band numeric, current_high_band numeric, session_regime text check in ('mean_reversion','bullish_trend','bearish_trend','mixed','ah_low_confidence'), vol_scalar numeric, vol_regime_shift bool, band_touch_last_fired_at jsonb, updated_at timestamptz, primary key (conid, session_date) }`. `anchors` is a chronological array of `{kind:'low'|'high', price, ts}` for replay/debug. `band_touch_last_fired_at` is the per-band-kind 4h cooldown clock: `{ "low": <iso-ts | null>, "high": <iso-ts | null> }`. `leg_direction` (`'up'|'down'|null`) is implementation-internal state — derived from the most recent anchor at row reload time, not stored as its own column. Cleanly reset at 16:30 IDT next session — no AH carryover. Realtime enabled (band chips update live as the engine ticks).

- **`curated_list`** *(dip-bounce track; see `signals/curated-list.md`)* — auto-maintained pool of ~200-300 high-potential dip-bounce candidates, per session date. `{ conid bigint, asof_date date, rank int, intraday_range_trader_score numeric, avg_daily_volume bigint, daily_atr_pct numeric, computed_at timestamptz, primary key (conid, asof_date) }`. `conid` references `universe.real_conid`. Rewritten daily at 09:00 IDT (full) + incrementally at 15:30 IDT (pre-market admit/drop). Realtime enabled (Screener FE + Watchlist chips subscribe). Retention drops rows older than 7 days.

- **`signal_fires`** *(dip-bounce track; see `signals/dip-bounce-scorer.md`)* — every signal fire by any scorer (intraday + swing dip-bounce now, band-touches + marker hits once ported onto the same backbone). `{ id uuid pk, conid bigint, signal_kind text check in ('intraday_dip_bounce','swing_dip_bounce','band_touch_low','band_touch_high'), score numeric, components jsonb, market_regime text, horizon text, price_at_fire numeric, fire_ts timestamptz default now() }`. Index on `(signal_kind, fire_ts desc)` for hit-rate queries. The `components` jsonb is the **explainable** breakdown `{ fired, weight, added, why }` per rule — `why` snapshots the raw engine values behind each rule (e.g. `{ drop_from_open_pct, band_p50, band_p75 }`) so a fire is fully legible after the fact (see `signals/signal-lab.md` → Explainability). `market_regime` is the `regime_proxy` state at fire time, for per-regime effectiveness analysis. Realtime NOT enabled (high churn; FE reads aggregated hit-rate, not individual fires).

- **`signal_outcomes`** *(dip-bounce track; see `signals/dip-bounce-scorer.md`)* — price snapshots at fixed offsets after each fire. `{ fire_id uuid references signal_fires(id) on delete cascade, t_offset text check in ('+30m','+2h','+1d','+3d'), snapshot_ts timestamptz, price numeric, return_pct numeric, primary key (fire_id, t_offset) }`. `signalOutcomesCron` looks up `quotes.canonical_price` at each due offset and writes the row; `return_pct = (price − signal_fires.price_at_fire) / signal_fires.price_at_fire × 100`. A SQL view `signal_hit_rate_30d` aggregates per `signal_kind`: `intraday_dip_bounce` reads `+2h` outcomes against +1% threshold; `swing_dip_bounce` reads `+3d` outcomes against +5%. **Not pruned** — fires/outcomes are kept forever (cheap; replay needs them — see `signals/signal-lab.md`).

- **`regime_proxy`** *(signal-lab; Batch X8; see `signals/signal-lab.md`)* — the market-regime instruments. `{ symbol text primary key, conid bigint, name text, kind text check in ('trend','vol'), regime_label text, recommended_count int default 0, updated_at timestamptz }`. Four rows: SPY / QQQ / IWM (trend) + VIX (vol). Daily bars come from `daily_bars` (Polygon) like any other symbol; `regime_label` is the derived current state used to stamp `signal_fires.market_regime`. `recommended_count` = our current rec set ∩ each ETF's constituents (via `etf_constituents`) — tells us which proxy actually matters for our universe.

- **`etf_constituents`** *(signal-lab; Batch X8; see `signals/signal-lab.md`)* — ETF membership map, one row per (etf, member). `{ etf_symbol text, member_symbol text, weight numeric, as_of date, primary key (etf_symbol, member_symbol) }`. ~2,600 rows (SPY ~500 + QQQ ~100 + IWM ~2,000). Rewritten weekly per ETF from the issuer holdings file (see `data/sources.md` → ETF constituents). A member in multiple ETFs gets multiple rows.

- **`signal_findings`** *(signal-lab; Batch X8; see `signals/signal-lab.md`)* — the lab's durable conclusions; permanent (raw fires/outcomes are not pruned, so a finding is always recomputable). `{ id uuid pk, grain text check in ('kind','kind_conid'), signal_kind text, conid bigint null, regime text null, window_start date, window_end date, expectancy numeric, hit_rate numeric, sample int, attribution jsonb, recommendation jsonb, created_at timestamptz default now() }`. `attribution` = per-component expectancy lift; `recommendation` = proposed knob deltas. `conid` null for `kind`-grain rows.

- **`signal_suppressions`** *(signal-lab; Batch X8; see `signals/signal-lab.md`)* — per-ticker keep/suppress, the only per-ticker lever (knobs stay global). `{ conid bigint, signal_kind text, suppressed bool default true, reason text, sample int, since timestamptz default now(), primary key (conid, signal_kind) }`. The scorer cron skips firing a kind for a conid with an active suppression. Server-side read; Realtime not required.

- **`signal_knobs`** *(signal-lab; Batch X8; see `signals/signal-lab.md`)* — runtime scorer weights/thresholds, moved out of `config/dipBounceScorer.ts` so the recommend-then-approve knob editor can write them. `{ signal_kind text, knob text, value numeric, updated_at timestamptz default now(), primary key (signal_kind, knob) }`. Code constants remain the **fallback** when a row is absent. Realtime enabled (scorer ↔ editor stay in sync).

- **`risk_flags`** *(risk-flags track; see `signals/risk-flags.md`)* — daily-grain enter-risk flags per `(conid, asof_date)`. `{ conid bigint, asof_date date, flags jsonb, severity text check in ('warning','critical'), computed_at timestamptz, primary key (conid, asof_date) }`. `flags` is an array of `{ key, severity, since, payload }`, one entry per **active** flag (absent key = condition not met). **A row exists only when ≥1 flag is active** — absence of a row = clean; the nightly pass deletes the row when conditions no longer hold. `conid` is the IB conid (held / watchlist → joins `positions` / `watchlist_items` / `quotes`); for curated-list names it's `universe.real_conid`. Rewritten nightly for the working set (held + active-watchlist conids; `curated_list` once X1 ships) + topped-up on-demand at Analyze. `severity` is the max over active flags. `since` is inherited from the prior day's row when the flag was already raised, so it reads "flagged since <date>" rather than resetting daily. Realtime enabled (card badge + Risk-flags section subscribe). Retention drops rows older than 7 days.

- **`news_sentiment`** *(news-as-signal track; Batch X7; see `signals/news-signal.md`)* — daily-grain news sentiment per `(conid, asof_date)`, the SSOT for the news fact. `{ conid bigint, asof_date date, score numeric, label text check in ('bullish','neutral','bearish'), article_count int, top_headline text, top_url text, source text default 'lexicon', computed_at timestamptz, primary key (conid, asof_date) }`. `score` ∈ ~`[-1, +1]` (clamped mean per-article sentiment from the LM-inspired lexicon over `companyNews` headlines/summaries, recency-weighted across a 48h window); `top_headline`/`top_url` are the highest-`|contribution|` article. Written by `newsSentimentCron` (held ∪ watchlist ∪ curated; **not** IB-gated). Two consumers: the risk-flags engine reads `score` → the `bad_news` WARNING flag (see `signals/risk-flags.md`), and `useVirtualList` joins it → news chip + good/bad rank nudge. Instrument-keyed grants (service_role write / authenticated read), Realtime enabled (the FE chip subscribes). `conid` is `universe.real_conid` (same key as `risk_flags` / `curated_list`).

- **`app_config`** — key/value runtime config: `{ key text primary key, value text not null, updated_at timestamptz default now() }`. RLS: public `select` (anon + authenticated), service-role only for write. Realtime enabled. Generic home for app-level runtime flags. Current keys:
  - `api_url` — current Cloudflare Quick Tunnel URL, written by the tunnel watcher; read by the FE on bootstrap and via Realtime subscription. See `architecture.md` → Public URL Discovery.
  - `llm_provider` / `llm_model` — active LLM selection (app-level, since API keys are global), written by `POST /api/config/llm`, read by the signal engine per analysis and by the Settings picker via Realtime. Keys themselves stay in `.env` — only the choice is here. See `signals/playbook.md` → LLM Provider Abstraction.

### Realtime publications

Enabled on: `positions`, `signals`, `analysis_locks`, `app_config`. Watchlist-pivot tables also: `quotes`, `watchlist_lists`, `watchlist_items`, `watchlist_markers`, `entry_zones`, `intraday_stats`. Screener-track tables also: `trait_scores`, `band_state`. Dip-bounce track also: `curated_list` (Screener tab + Watchlist chips subscribe to all). Risk-flags track also: `risk_flags` (card badge + TickerDetail Risk-flags section subscribe). News-as-signal track also: `news_sentiment` (Batch X7 — the virtual-list news chip subscribes). Signal-lab track also: `signal_knobs` (Batch X8 — scorer ↔ knob-editor sync). `signal_fires` and `signal_outcomes` are NOT published — internal infra; FE reads aggregated hit-rate via the `signal_hit_rate_30d` view. `daily_bars` is NOT published either — high churn, server-side-only consumers. `regime_proxy` / `etf_constituents` / `signal_findings` / `signal_suppressions` are server-side-only (lab + scorer reads), not published.

### Row Level Security

Enforced on every user-data table. Service role bypasses RLS for backend writes.

**Instrument / signal tables need an explicit read *policy*, not just a grant.**
Supabase enables RLS on every table at create, and with RLS on a `SELECT` grant
to `authenticated` is **necessary but not sufficient** — with no policy the role
reads **0 rows, silently** (no error). Market-wide tables the FE reads directly
(`quotes`, `curated_list`, `trait_scores`, `band_state`, `signal_fires`,
`signal_outcomes`, `news_sentiment`) each carry a `… : authenticated read`
policy `for select to authenticated using (true)`. Migration `033` backfilled
the six that were created with the grant but no policy — the latent cause of the
empty virtual lists (only `quotes` had shipped with its policy). When adding a
new FE-read instrument table, add its read policy in the same migration.

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
