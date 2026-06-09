# Upside — Build Queue (Completed)

Archive of completed batch summaries. The active queue lives in `BUILD_QUEUE.md` (un-done batches only); newly-finished batches are summarized here on completion. For full implementation history see `git log`; for the durable design baked in by each batch see the relevant file(s) under `spec/`.

---

## Completed batches

> Compact one-paragraph summaries. For full original batch descriptions, see git history. For the durable design baked in by each batch, see the relevant file(s) in `spec/`.

### Batch 1: Portfolio home screen — COMPLETE
Scaffolded React + Vite + TypeScript. Built Portfolio Home with mock data: `PositionCard`, `SummaryStrip`, `SortBar`, `MarketPeriodBadge`, `Sparkline`, `BottomNav`. Dark mode via CSS variables, mobile-first 375-390px. PWA manifest + service worker shell. Commit: 86b0b83.

### Batch 2: Ticker detail — layout & static components — COMPLETE
Slide-in from right at `/ticker/:symbol`. Built `TickerDetail`, `TodayRange`, `MarketStats` (with inline edit panel), `ChartControls`, `TimeframeBar`, collapsible `SignalSection` / `PositionStats` / `IndicatorsSection`. Chart placeholder for Batch 3. Commit: 49f8740.

### Batch 3: Ticker detail — chart integration — COMPLETE
Lightweight Charts (TradingView) integrated. `PriceChart` with candle/line toggle, VWAP overlay, RSI subchart, volume bars, entry-price dashed line, entry-date marker. Touch-friendly pinch/pan. Mock OHLCV data for multiple timeframes. Commit: 41162b4.

### Batch 4: Oracle VPS + Docker setup — COMPLETE [was MANUAL]
Oracle Cloud Always Free instance provisioned in Ashburn (4 ARM OCPU, 24 GB RAM, 200 GB). Ubuntu 24.04. Docker + Compose installed. OS firewall opened for 80/443 (critical — Oracle iptables blocks even with security list allowing). Commit: 41162b4.

### Batch 5: Docker Compose + Supabase schema + Node.js API scaffold — COMPLETE
Compose stack (`ib-gateway`, `api`, `redis`). Node.js scaffold with route handlers for auth, portfolio, marketdata, signals. Services for IB gateway, Redis, Supabase, LLM (provider-agnostic), technicals, Finnhub. Cron skeletons for `pricePoller`, `signalRunner`, `keepalive`. `supabase/migrations/001_initial.sql` with positions, signals, user_preferences, analysis_locks, access_attempts (`position_history` dropped in Batch 14.5 — never had a real consumer). `.env.example`. Commit: 182fd29.

### Batch 6: Schema reconciliation + IB mappers + snapshot fix — COMPLETE
After Batch 7 captures revealed gap with IB reality: added `conid`/`account_id`/`currency`/`asset_class`/`industry`/`category` to positions, `conid` to signals, new `contracts` cache table. Built `ibMappers.ts`. Rewrote `ibSnapshot` to use subscribe-wait-fetch pattern (first call subscribes, ~1s wait, second returns populated data). Fixed snapshot field codes per IB docs. Commit: f7cdfef.

### Batch 7: Raw IB Client Portal data capture — COMPLETE
Built `infra/clientportal.gw/Dockerfile` wrapping IB's official `clientportal.gw.zip`. Built `server/scripts/captureIb.ts` that sweeps every IB endpoint our code expects, one file per call into gitignored `captures/`. Surfaced + fixed `docker-compose.yml` bug (wrong image — referenced TWS Socket API instead of Client Portal REST). Commit: babbca8.

### Batch 7.5: Collapse migrations into single baseline — COMPLETE
Folded `002_align_with_ib.sql` into `001_initial.sql` pre-deploy. Single source-of-truth schema file. Future post-deploy migrations will be proper sequential alters. Commit: 6ed224b.

### Batch 8: Supabase project provisioning — COMPLETE [was MANUAL]
Live Supabase project `upside-prod` in US East 1 / Virginia. Migrations applied. Auth → Google OAuth provider enabled. URL config set to Vercel domain. Three credentials saved.

### Batch 9: Real-time price loop + frontend wiring — COMPLETE
Full `pricePoller` (poll IB every 5-15s during market hours, cache Redis, write Supabase only on change). `useMarketSession` polls auth status. FE wired to Supabase (REST + Realtime). Session-expired UI implemented (later refactored in Batch 13 to cached-first model). Commit: c90b33b.

### Batch 10: Deploy BE compose stack to Oracle VPS — COMPLETE [partly MANUAL]
First `docker compose up -d` in production. Surfaced + fixed http→https scheme bug for IB Client Portal Gateway (axios with self-signed cert support, `IB_GATEWAY_URL` to https in compose). Filed deferred grants issue for `analysis_locks`. Commits: 1d97339, a87c8c3, d7ecc41.

### Batch 11: Self-healing Cloudflare Quick Tunnel + FE URL bootstrap — COMPLETE
Cloudflared compose service with `--no-autoupdate`. New `002_app_config.sql` (key/value runtime config table). `tunnelWatcher.ts` parses cloudflared log → upserts `app_config.api_url`. FE bootstraps API URL from Supabase, subscribes to Realtime for URL changes. No `VITE_API_URL` env var. Self-healing test verified end-to-end (restart cloudflared → new URL in Supabase within ~15s → FE swaps without manual action). Three follow-on fixes: cloudflared user:root for logfile perms, service_role grant for app_config, optimistic-claim dedup in watcher. Commit: b4b88fa.

### Batch 12: Google OAuth end-to-end — COMPLETE [MANUAL + code]
Google Cloud OAuth client + Supabase Auth provider config. `Login.tsx` + `AuthGuard.tsx` with email whitelist enforcement. Non-whitelisted bounce to google.com. Follow-ons: `003_service_role_grants.sql` (resolved deferred Batch-10 grants issue), AuthGuard dedup-by-token with localStorage persistence, prompt=select_account on signInWithOAuth. Commit: bfa1d52.

### Batch 13: Vercel FE deploy + on-demand IBeam — COMPLETE [MANUAL + code]
Vercel FE live at `upside-client.vercel.app`. PWA installed on phone. Full live path verified end-to-end with real portfolio: phone → Vercel FE → Supabase app_config → Cloudflare Quick Tunnel → api → IBeam → IBKR → positions in Supabase → portfolio screen populated. Final IB auth: on-demand IBeam (`voyz/ibeam:0.5.11`), tagged `profiles: [manual]`, user taps Connect/Disconnect/Cancel in FE, api uses mounted Docker socket (dockerode) to start/stop container. Cooperates with IBKR Mobile (single-session limit no longer fights us). pricePoller no longer gates on market hours — adaptive cadence so positions populate even on weekends. Five IB-auth approaches explored along the way (programmatic POST → 401; api path-proxy → 404; second Quick Tunnel → cookies; full-time IBeam → battle royale with IBKR Mobile; OAuth 1.0a Extended → parked on `oauth-dev` branch waiting for IBKR approval). Discord error notifier (two channels — routine + critical) added so future iterate-build-test-debug loops are minutes, not SSH-and-grep. **🎯 Data-only live milestone reached.** Commit: 7392946. Auth-approach institutional memory now lives in `spec/archive.md`.

### Batch 13.1: Restore navigation + deeper /healthz — COMPLETE
Re-wired routing regression discovered post-Batch-13. Components from Batches 2-3 (Ticker Detail screen, slide-in, chart, collapsible sections) existed but nothing routed to them. PositionCard tap → `/ticker/:symbol`. Bottom nav routes to `/alerts` and `/settings` ComingSoon placeholders. `/healthz` extended to report component statuses (ib, supabase, redis, lastPricePoll) with per-check 1s timeouts.

### Batch A1: Watchlists + IB import + `quotes` table + TickerDetail-for-non-held — COMPLETE
First slice of the 2026-05-28 watchlist pivot. Migration `011_watchlist_and_quotes.sql` (quotes + watchlist_lists + watchlist_items, RLS + Realtime). `POST /api/watchlists/sync` (IB-gated, filters to `user_lists`). `PATCH /api/watchlists/:list_id` for active/hidden toggle. New `watchlistQuotePoller` covers watchlist-only conids; `ibPricePoller` + `finnhubPricePoller` mirror held prices into `quotes` via `upsertQuote`. FE Watchlist tab (`pages/Watchlist.tsx`) with empty state, sub-tab strip per active list, in-screen settings sheet, sparklines (migration 015 added `today_change_pct` + `sparkline_closes`), company names (migration 014). TickerDetail unchanged — works for non-held via the canonical-quote read. See `spec/screens/watchlist.md` + `spec/schema.md` → quotes / watchlist_lists / watchlist_items.

### Batch A2: Manual price markers + dip-buy Discord alerts — COMPLETE
Migration `012_watchlist_markers.sql` + later **`016_markers_rekey.sql`** which re-keyed markers from `item_id` to `(user_id, conid)` (one set per ticker, shared across every list it appears on — bug surfaced when the same conid in two lists showed markers in only one). CRUD routes (`POST/PATCH/DELETE /api/watchlist-markers/...`). `checkMarkersForConid` fires from `upsertQuote` with transition + 24h cooldown rules per `spec/flows.md`. `notifyMarkerHit` → `#upside-dip-buys` (env `DISCORD_WEBHOOK_DIP_BUYS`); first cut wires only `at_or_below`. FE: long-press / right-click opens `MarkerSheet`; marker chips inline on the watchlist row, tap-to-edit. See `spec/signals/markers.md`.

### Batch A+: Dynamic entry-zone engine + vitest test suite — COMPLETE
Migration `013_entry_zones.sql`. Pure `computeEntryZones` in `server/src/services/entryZones.ts` with simple v1 trend regime (SMA20 slope + price-vs-SMA50), overbought-forgiveness, confluence detection. **Round-number magnets removed** post-test (2026-05-29) — they generated zones above current price, reading as "buy market" (see `spec/signals/entry-zones.md` → Candidate levels). Vitest pinned at v2 (vite-5 compat); test fixtures cover trending up, overbought, capitulation, edge cases. `checkEntryZonesForConid` fires from `upsertQuote` with 24h cooldown per `(conid, horizon)` → `#upside-dip-buys` (shared channel for first cut). FE: `EntryZoneCluster` (collapsed overnight chip + hover/tap popover for all three horizons with reasoning + confidence + "promote to manual marker" action), `Glossary` help icon in Watchlist header. See `spec/signals/entry-zones.md`.

### Batch B: Intraday-stats engine + typical-low band alerts — COMPLETE
Migrations `017_intraday_stats.sql` (the stats row — 3 stats × 3 percentiles + sample_size + lookback_days + last_fired_at) and `018_quotes_today_open.sql` (the band needs today's open in price space). Pure `computeIntradayStats` in `server/src/services/intradayStats.ts` (60-day default lookback, 6 fade bars, vitest fixtures green). 24h-cadence `intradayStatsCron` (IB-gated, first run 5min after boot). All three pollers thread `today_open` through `upsertQuote` (IB snapshot field `7295` / Finnhub `quote.o`). `checkIntradayStatsForConid` fires from `upsertQuote` on cross-into-band → `#upside-stats-alerts` (env `DISCORD_WEBHOOK_STATS_ALERTS`, blue embed). FE: `IntradayStatsChip` (3-state color-coded chip on the watchlist row), `IntradayStatsPanel` (collapsible on TickerDetail), `useIntradayStats(symbol)` hook for the single-symbol read. See `spec/signals/stats.md`.

### Slice: Portfolio MTD card removed — COMPLETE
`SummaryStrip` MTD card stripped 2026-05-29 (Redis-cached month-start fallback unreliable, user's primary anchor is current value). Portfolio screen now shows just Portfolio Value. `spec/screens/portfolio.md` records the prior design for future restoration if needed.

### Slice: Vercel SPA hard-refresh fix — COMPLETE
`client/vercel.json` adds a rewrites rule (everything except `/assets/`, `/sw.js`, workbox, manifest, favicon, robots → `/index.html`) so hard-refresh on `/watchlist`, `/ticker/:symbol`, etc. doesn't 404. Schema validation in Vercel rejected the `comments` field — stripped to just `$schema` + `rewrites`.

---

## Signal / playbook track (Batches 13.2–14g)

> One-liners only — full "What shipped" entries live in `CLAIMS_DONE.md`; git log has the diffs.

- **13.2** — generic IB passthrough debug endpoint (`/api/debug/ib/*`, allowlisted).
- **13.5** — `tradingDaysHeld` + MTD return (Redis month-start anchor; MTD card later removed).
- **13.7** — Finnhub rate-limited request queue (per-category min-intervals, the backbone every Finnhub caller shares).
- **13.8** — multi-source price polling (IB primary + Finnhub fallback, `price_source` tracking).
- **14a** — signal engine + manual analysis end-to-end (later reshaped by 14g).
- **14c** — profit-taking zone detection + Discord + card UI (`zone_*` fields on positions).
- **14e** — marketdata snapshot endpoint + TickerDetail wire-up (Today's Range + Market Stats).
- **14f** — TickerDetail real-data chart + signal polish.
- **14.5** — schema cleanup, removed `position_history`.
- **14g** — single-direction **playbook** engine: computed feature pack (`technicals.ts`), per-leg legs + horizon, `signals.playbook jsonb`, level-anchored prompt. (Migration `010_playbook.sql`.)

---

## Screener track (Batches S0.3–S3)

- **S0.3** — async job queue `screener_jobs` (partial-unique dedup index, per-pool workers ib/finnhub/compute, reaper + retention). Migration `021`. The infra every screener cron runs on.
- **S0.5** — universe price+volume coverage: Polygon grouped-daily (primary) + Yahoo v8/chart (per-gap fallback) via the job queue. Migration `022` (`universe.last_volume`). `services/universeQuote.ts` + `universeQuoteProducer`.
- **S1** — `universe` table + nightly Ring-1 filter cron (Finnhub symbol list → type/MIC sieve → price/cap gate). Migration `019`. Synthetic FNV conid PK.
- **S1.5** — real IBKR conid resolution via `ibSecdefSearch` on the `ib` pool. Migration `023` (`real_conid` + `auto_promoted`). `conidPicker` (US-STK match, first-listed tiebreak).
- **S2** — three trait scorers (`intraday_range_trader` / `catalyst_reversal` / `post_earnings_drift`) → `trait_scores`; staggered `intradayStatsCron` (1/7 universe/day); weekly cap refresh; first-fire Discord. Migrations `024` (trait_scores) + `025` (screener_jobs.result).
- **S3** — adaptive band engine: session-regime + vol-scalar + walking-state + vol-regime-shift layers on the static intraday_stats band; `bandEngineCron`; band-touch Discord (4h cooldown). Migration `026` (`band_state`).

---

## Dip-bounce + data-SSOT track (Batches X1–X7, X9)

- **X1** — dip-bounce track: `curated_list` pool, intraday + swing scorers → two suggestion channels, and the durable `signal_fires` / `signal_outcomes` / `signal_hit_rate_30d` forward-tracking backbone. Migration `028`. Compute-set widening (curated ∪ active-watchlist ∪ held).
- **X2** — Watchlist virtual lists (Intraday ✨ / Swing ✨ leaderboards) rendering X1's outputs in the Watchlist screen; retired the standalone Screener tab. Pure FE (`useVirtualList`, `VirtualList*`). No migration.
- **X3** — curated-list volume gate fix: 30d median ADV computed from the daily bars the cron already pulls (the empty-list bug — `universe.last_avg_volume` was never populated). No migration.
- **X4** — `daily_bars` layer: Polygon-primary daily-grain SSOT (one call → whole universe, weekend-safe), 30d bootstrap + Yahoo gap-fill; repointed curated cron / swing pack / sparkline off IB history; `universe.last_avg_volume` derived from it. Migration `029`.
- **X5** — price SSOT: `quotes` is the only price table; dropped 9 price/P&L columns from `positions` (migration `030`); market value + P&L recomputed from `quotes.canonical_price × shares` in the FE hooks + portfolio summary + signalEngine.
- **X6** — earnings calendar single shared daily pull (`services/earningsCalendar.ts` memo) — two Finnhub calls/day → one. No migration.
- **X7** — news-as-signal: LM-inspired finance-lexicon scorer over `companyNews` → `news_sentiment` SSOT → `bad_news` WARNING risk flag + FE news chip / rank nudge on the virtual lists. Migration `031`.
- **X9** — populate the virtual lists: fixed the curated-list build race (latest-available date, not strict today) + seeded daily-close `quotes` for curated names (`seedDailyQuotes`); fresh-price firing gate (stale renders, never fires) + FE "as of" / stale badge. Migration `032`.

---

## Risk-flags track (Batches R1–R2)

- **R1** — daily-grain danger-flag engine (six flags + WARNING/CRITICAL tiers, pump detection), `risk_flags` table, signalEngine top-up + LLM pump-downgrade clamp (`signalQuality ≤ 35` on CRITICAL). Migration `027`.
- **R2** — risk-flags FE: `DangerBadge`, TickerDetail Risk-flags section, CRITICAL pre-analysis gate, Settings threshold controls; first `user_preferences` FE→BE write (`GET/PUT /api/user/preferences`). No migration.

---

## Meta (Batch M1)

- **M1** — agent context efficiency: read-counter hook + `bin/upside-readstats`; split `BUILD_QUEUE_DONE.md` / `CLAIMS_DONE.md` out of the active files; extracted claim-batch / finish-batch / spec-edit skills; hierarchical `spec/` README index; slimmed `AGENTS.md`.

---

## MVP app-shell (Batch 15)

- **15** — app-shell Settings screen: added **IB connection** (reuses `IbStatusIndicator` + `useMarketSession`), a **profit-taking zone** slider (→ `user_preferences.profit_zone_threshold_pct`), a **theme** picker (System/Light/Dark via `data-theme`, palettes already in `tokens.css`, applied pre-paint in `index.html`), and **sign out** — on top of the already-shipped Analysis-engine + Risk-flags sections. Extended `PUT /api/user/preferences` to carry `profit_zone_threshold_pct` under a `preferences` object (new `useUserPreferences` hook + `services/theme.ts`). The signal-generation / Analyze-flow knobs (signal threshold, min market value, suppressed symbols) were scraped out to the LLM-analysis roadmap (`spec/roadmap.md` → Track 4 item 9). No migration. Commit 54670fb.

---

## Job-queue gates (Batch X10)

- **X10** — per-action precondition layer on the job-queue worker: an action registers a gate in `gateRegistry[action]`; the worker evaluates it post-claim / pre-execute and on not-ready **defers** the job (`scheduled_for=retryAt`, `attempts` unchanged) instead of executing-and-failing. New `services/jobs/gates.ts` (`requiresRthOpen` / `requiresMarketOpen`, injectable clock), `marketHours.nextRegularOpenEtIso` (DST-correct next-09:30-ET), `queue.deferJob`. Fixes the `catalyst_reversal` 0-rows bug — both stages declare `requiresRthOpen` (Stage-1 needs the live `7295` open field, Stage-2 `ibHistory` 503s off-hours), so overnight claims defer to RTH instead of failing. Channel rename `DISCORD_WEBHOOK_CATALYST_ALERTS` → `_EVENT_ALERTS` (old var read as fallback). No migration. `gates.test.ts` +6 (200 total). Commit a5c8664.
