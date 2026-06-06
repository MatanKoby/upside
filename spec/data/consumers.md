# Data Consumers — who reads what

Every consumer of stored or external data: crons, engines, API routes, and the
client. For each, **what it reads, what it writes, and which external source it
hits**. Paired with [`sources.md`](sources.md) (where data comes from) and
[`../schema.md`](../schema.md) (the tables). The goal is to confirm each consumer
reads from the **single source of truth** for a given fact, no two consumers
maintain parallel pipelines for the same data, and a consumer fetches what it
needs in **one request** rather than several.

Maintenance rule: when a consumer starts/stops reading a table or calling a
source, update its row here and the storage entry in `sources.md`.

Legend: **R** = reads table · **W** = writes table · *(src)* = external source.

---

## Crons — producers

| Cron | Reads | Writes | External | Cadence |
| --- | --- | --- | --- | --- |
| `universeCron` | `universe` | `universe` | Finnhub `getSymbolList` / `getQuote` / `getProfile2` | nightly |
| `conidResolutionProducer` | `universe` | `universe.real_conid` | IB `secdef/search` | continuous (queue) |
| `universeQuoteProducer` | `universe` | `daily_bars`, `universe.last_price` / `last_volume` / `last_avg_volume` | Polygon grouped-daily + Yahoo gap-fill | daily |
| `marketCapRefreshCron` | `universe` | `universe.last_market_cap_m` | Finnhub `getProfile2` | weekly |
| `intradayStatsCron` | `universe` | `intraday_stats` | IB history (5-min bars) | nightly |
| `intradayRangeTraderProducer` | `universe`, `intraday_stats`, `quotes` | `trait_scores` (intraday_range_trader) | — (compute) | nightly |
| `catalystReversalProducer` | `universe`, `trait_scores` | `trait_scores` (catalyst_reversal), `universe` (auto-promote) | Finnhub `earningsCalendarRange` + news | daily |
| `postEarningsDriftProducer` | `universe` | `trait_scores` (post_earnings_drift) | Finnhub `earningsCalendarRange` | daily |
| `curatedListCron` | `trait_scores`, `daily_bars` | `curated_list` | — (ATR% + median ADV from `daily_bars`; no longer IB-gated, Batch X4) | 12h + boot-kick |
| `bandEngineCron` | `intraday_stats`, `band_state`, compute-set | `band_state` | (computed from stats) | per session |
| `entryZonesCron` | `quotes` | `entry_zones` | — | per poll cycle |
| `dipBounceCron` *(service)* | `quotes`, `intraday_stats`, `band_state`, `entry_zones`, `curated_list` (via `computeSet`), `daily_bars` (swing pack) | `signal_fires` | Discord webhooks | 60s |
| `signalOutcomesCron` | `signal_fires`, `quotes` | `signal_outcomes` | — | 5min |
| `riskFlagsCron` | `user_preferences`, `positions`, `quotes` | `risk_flags` | Finnhub `basicFinancials` + `earningsCalendar` | daily |
| `ibPricePoller` | `contracts`, `positions` | `contracts`, `positions` (holding facts only), `quotes` (price) | IB positions + snapshot | poll loop (IB up) |
| `finnhubPricePoller` | `positions` | `quotes` (price), `positions` (price-source metadata + zone state) | Finnhub `getQuote` | poll loop (IB down) |
| `watchlistQuotePoller` | `positions` | `quotes` (via `services/quotes`) | Finnhub `getQuote` | poll loop |

### Maintenance / housekeeping crons (no business data)

`jobsReaper` + `jobsRetention` (`screener_jobs`), `lockCleanup` (`analysis_locks`),
`metricsRetention` (`external_api_metrics`), `traitScoresRetention` (`trait_scores`),
`zoneGapCleanup` (`positions` scan), `keepalive` (IB tickle), `tunnelWatcher`
(`app_config` — public URL).

---

## Engines / services

| Service | Reads | Writes | External |
| --- | --- | --- | --- |
| `signalEngine` | `positions`, `contracts`, `user_preferences` | `analyses`, `signals`, `analysis_locks` | IB snapshot + history (feature pack); Finnhub `companyNews` / `earningsCalendar` / `insiderTransactions` / `basicFinancials` |
| `riskFlags/engine` | (inputs from `riskFlagsCron`) | `risk_flags` | — |
| `entryZoneAlerts` | `entry_zones` | `entry_zones` | Discord |
| `intradayStatsAlerts` | `intraday_stats`, `quotes` | `intraday_stats` (alert state) | Discord |
| `markers` | `watchlist_markers` | `watchlist_markers` | Discord |
| `profitZone` | `user_preferences` | — | Discord |
| `services/quotes` | `quotes`, `watchlist_lists`, `watchlist_items` | `quotes` | — (writer for the pollers) |
| `services/watchlists` | `watchlist_lists`, `watchlist_items` | `watchlist_lists`, `watchlist_items` | IB watchlists |
| `appConfig` / `tunnelWatcher` | `app_config` | `app_config` | — |

---

## API routes

| Route | Reads | Writes | External |
| --- | --- | --- | --- |
| `portfolio` | `positions`, `quotes` (`/summary` recomputes value+P&L from canonical_price × shares) | — | — |
| `marketdata` | `positions`, `daily_bars` (sparkline) | — | IB snapshot / history (live pass-through); sparkline reads `daily_bars` first, IB fallback (Batch X4) |
| `signals` | `analyses`, `analysis_locks` | `analysis_locks` (+ triggers `signalEngine`) | — |
| `watchlists` | `watchlist_*` | `watchlist_lists` / `items` | IB watchlists (sync) |
| `watchlist-markers` | `watchlist_markers` | `watchlist_markers` | — |
| `user` | `user_preferences` | `user_preferences` | — |
| `config` | `app_config` | `app_config` | — (LLM provider pick) |
| `auth` | `access_attempts` | `access_attempts` | Google OAuth; IB connect/disconnect |
| `health`, `debug` | — | — | IB raw (debug) |

---

## Client (hooks → tables / API)

| Hook / page | Reads (Supabase) | Calls (API) |
| --- | --- | --- |
| `usePositions` | `positions`, `quotes` (join by conid → recompute price + P&L) | — |
| `usePortfolioSummary` | — | `/api/portfolio/summary` |
| `useTickerDetail` | `positions`, `watchlist_items`, `quotes` | — |
| `useChartHistory` | — | `/api/marketdata/history` |
| `useSparkline` | — | `/api/marketdata/sparkline` |
| `useWatchlistData` | `watchlist_lists`, `watchlist_items`, `quotes`, `watchlist_markers`, `entry_zones`, `intraday_stats` | `/api/watchlists/*` |
| `useVirtualList` | `curated_list`, `trait_scores`, `quotes`, `band_state`, `signal_fires`, `signal_outcomes` | — |
| `useRiskFlags` / `useRiskFlagConfig` | `risk_flags` | — |
| `useSignals` | `signals`, `analyses` | `/api/signals/analyze` |
| `useAnalysisLock` | `analysis_locks` | — |
| `useIntradayStats` | `intraday_stats` | — |
| `useLlmConfig` | — | `/api/config/llm` |
| `apiUrl` | `app_config` | — |
| `useMarketSession` | — (local clock) | — |

Pages: `PortfolioHome`, `Watchlist`, `TickerDetailPage`, `Settings`, `Login`,
`ComingSoon` (placeholder for Alerts — Batch 15).

---

## Observations (for the SSOT / pipeline audit)

1. **`useVirtualList` joins 6 tables client-side** (curated/trait/quotes/band/fires/outcomes) with a per-conid hit-rate recompute. Correct for now, but if it gets heavy a server-side `/api/virtual-list` (or a materialized view) would collapse it to one request — flag for after live data exists.
2. **Per-ticker hit-rate recomputed in the client** because `signal_hit_rate_30d` aggregates per *kind*, not per *conid*. If other surfaces need per-conid hit-rate, promote it to a view rather than duplicating the client math.
3. **`positions` is read by ~10 consumers** — it's the de-facto held-state SSOT (holding facts only). Price + P&L no longer live here (Batch X5): readers join `quotes` by conid and recompute, so there's no `current_price`-vs-`canonical_price` divergence to police (`sources.md` → Observation 4, resolved).
4. **`trait_scores` written by 3 producers, read by `curatedListCron` + `useVirtualList`** — clean fan-in/out; the two earnings-based producers now **share one earnings-calendar pull** (Batch X6 — `sources.md` → Observation 6).
5. **Alerts screen (Batch 15) is unbuilt** — `ComingSoon`. When built it consumes `signals` / `signal_fires` / `entry_zones` events; design it to read the existing tables, not a new pipeline.
