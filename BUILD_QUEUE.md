# Upside — Build Queue

Reference spec: [`spec/`](spec/README.md) (split across 6 domain files + archive)
Agent work tracking: `CLAIMS.md` (managed by coding agents)

## How this works

- Un-done batches listed in full; completed batches collapsed to summaries (git log has the implementation history).
- Dependencies are listed where they exist — the agent decides execution order.
- Agents claim and track completion in `CLAIMS.md`.
- Batches are designed so two agents can work on different batches simultaneously without file conflicts.

When picking a batch to claim, skim the **Completed batches** section first for context (one-liners are fast), then read the un-done batches in full.

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

## Un-done batches

> **Pick-order pointer for "continue".** S0.3 / S0.5 / S1.5 / S2 have all landed (job queue + universe price+volume + real conid resolution + three-trait scoring engine). The screener track now sequences as **S3 → S4**, with **S3 the next claim** (band engine — adaptive layers on top of the static intraday-stats band). Other un-done items in rough priority order: **Batch C remainder** (per-marker cooldown UI, `at_or_above` channel routing, stats-alert second trigger) · **Batch 15** (alerts feed + settings) · **Batch 14h** (live per-leg tracking + Refine) · **Batch 13.9** (Finnhub cadence tuning) · **Batch 16** (PWA push + remaining polish). **Blocked / deferred:** 13.3 (waiting on IBKR support reply re secondary-user market-data cost), 14b + 14d (deferred behind LLM signal-quality sharpening). When the user types "continue" after a context clear, **ask** which un-done batch to claim — but **S3** is the most likely answer right now.

---

## Batch S0.3: Async job queue (`screener_jobs`)

**Depends on:** none (it's the foundation downstream batches migrate onto).

**Scope:** Implement the Postgres-backed async job queue per **`spec/job-queue.md`**. Producers (cron schedulers) enqueue deduplicated jobs; workers (per-pool: `ib` / `finnhub` / `compute`) drain via atomic claims. Without this, S0.5 / S1.5 / S2 / S3's IB-touching crons each have to re-invent their own connection-window handling and stale-data avoidance — and the user would lose work whenever IB is offline. Pure infrastructure batch; no user-facing change.

### Deliverables

1. **Migration `021_screener_jobs.sql`** — `screener_jobs` table per `spec/schema.md` → `screener_jobs`, including the **partial unique index** on `job_key` filtered to `status IN ('queued','claimed')` (the dedup mechanism). Index on `(worker_pool, status, scheduled_for, priority)` for the worker's claim query.

2. **`server/src/services/jobs/queue.ts`** — producer-facing helpers (pure functions over Supabase):
   - `enqueue(action, payload, opts)` → builds deterministic `job_key`, runs `INSERT ON CONFLICT DO NOTHING`. Returns `'created' | 'deduped'`.
   - `drainCompleted(action)` → returns the `done` + `failed` rows for the action (so the producer can act on them in its cycle).
   - `markRetry(jobRow)` → inserts a fresh row with the same `job_key` (the failed row is outside the partial index, so insert succeeds); deletes the failed row.
   - `finalizeFailure(jobRow, reason)` → deletes the failed row, fires a Discord notification through the existing `notifyApiFailure` policy.
   - `makeKey(action, parts)` → canonical key constructor used by every producer.
   - Vitest: dedup-against-active, success-then-re-enqueue-tomorrow, failed-then-retry, race-safety smoke (insert N concurrent same-key, expect 1 created).

3. **`server/src/services/jobs/worker.ts`** — worker-pool framework:
   - `createWorker(pool, opts)` → returns a loop runner: `start()`, `stop()`.
   - `atomicClaim(pool)` → `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` followed by the claim UPDATE in one tx. Sets `lease_expires_at = now() + LEASE_DURATION` (default 5 min).
   - `executeJob(job, registry)` → look up the action's handler in the worker's `registry`, call it, catch errors, persist outcome (`done` + result write, or `failed` + last_error + attempts++).
   - **Pool gating** is `opts.poolGateOk()` — a per-pool predicate the framework calls before each claim. For `ib`, gates on `ibStatus().connected && .authenticated`. For `finnhub`, always true (the queue limiter inside Finnhub handlers handles backpressure). For `compute`, always true.
   - No retry logic in the worker — pure execute-and-report per spec.

4. **`server/src/services/jobs/actions.ts`** (or a registry pattern, your call) — typed registry of action handlers. S0.3 ships **two placeholder no-op actions** for the framework smoke test: `'noop:ok'` (always succeeds) and `'noop:fail'` (always throws). Real actions (resolve_conid, refresh_intraday_stats, etc.) land in their owning downstream batches and register themselves into the worker's action map.

5. **`server/src/cron/jobsReaper.ts`** — runs every 60s, flips `status='claimed' AND lease_expires_at < now()` rows to `status='failed'` with `last_error='lease expired'`. Logs count to stdout.

6. **`server/src/cron/jobsRetention.ts`** — daily sweep, deletes `done OR failed` rows older than 7 days. Safety net (producers should normally drain on their own cycle).

7. **Boot wiring** in `server/src/index.ts`:
   - Start one worker per pool (`ib`, `finnhub`, `compute`).
   - Start `jobsReaper`.
   - Start `jobsRetention`.
   - Workers join the existing cron set; producers are added incrementally as downstream batches land.

8. **Observability** (minimal v1):
   - `bin/upside-psql -c "select worker_pool, status, count(*) from screener_jobs group by 1,2 order by 1,2;"` — the queue-depth-at-a-glance query (call out in this batch's verification).
   - On circuit-breaker-style sustained failure (≥10 failures within 5 min for a single action), `services/notify.ts:notifyCritical` to `#errors-critical`. Acts as the early warning before a full dashboard exists.

### Files this batch creates/edits
- `supabase/migrations/021_screener_jobs.sql` (new)
- `server/src/services/jobs/queue.ts` (new + vitest)
- `server/src/services/jobs/worker.ts` (new + vitest)
- `server/src/services/jobs/actions.ts` (new — empty action registry + the two `noop:*` placeholders)
- `server/src/cron/jobsReaper.ts` (new)
- `server/src/cron/jobsRetention.ts` (new)
- `server/src/index.ts` (boot wiring — start three workers + two crons)
- `server/src/services/notify.ts` (extend with `notifyJobQueueCircuit(action)` if not already covered by `notifyCritical`)

### Does NOT touch
- Any business logic (no real actions; S0.3 ships only the framework + `noop:*` placeholders).
- Existing crons (S0.5 / S1.5 / S2 / S3 migrate themselves onto the queue when they land; S0.3 doesn't migrate the existing pollers — those keep their current shape).
- Any FE surface.

### Verification

- Migration applied.
- Boot logs show three worker pools started + reaper + retention crons.
- Smoke: enqueue 100 `noop:ok` jobs, observe queue counts via the psql query above. Workers drain to zero within ~1 minute. Enqueue 100 `noop:fail`, observe all transition to `failed` and `notifyJobQueueCircuit` fires once at the threshold breach.
- Dedup smoke: call `enqueue('noop:ok', {x:1})` twice in quick succession; second call returns `'deduped'`, only one `queued` row exists.
- Crash safety: kill the worker process mid-claim, wait for reaper, observe row transitions back through `failed` (lease expired). Producer's retry path is exercised by the downstream batches' producers — not this batch's verification.
- Concurrent-claim safety: spawn 4 worker processes against 1,000 queued `noop:ok` jobs, confirm no duplicate execution (each job's done timestamp is unique to one worker's `claimed_by`).

### Out of scope (per `spec/job-queue.md` → "What this layer does NOT do")

- DAGs / declarative dependencies (cross-stage chaining lives in producer logic).
- Heartbeat / lease renewal (jobs assumed to fit within `LEASE_DURATION`).
- Realtime worker observability dashboard (psql query + Discord notifications are enough for v1).
- External queue infra (BullMQ / RabbitMQ / NATS).
- Job-payload encryption.

---

## Batch S0.5: Universe price + volume coverage research + integration

**Depends on:** Batch S1 (universe table exists), Batch 13.7 (Finnhub queue).

**Scope:** Decide how to keep `quotes.canonical_price`-style data fresh for **universe tickers** (~3,000 Ring-1 IN) — not just the ~25 held + watchlist conids the existing pollers cover. Specifically resolves the gap that **Finnhub free `/quote` has price but no volume**, and the `catalyst_reversal` Stage-1 broad detection needs volume on ~5,300 tickers nightly without pushing daily IB usage past the on-demand budget.

**Research portion** (~half-day): evaluate free-tier alternatives on (a) does it give volume? (b) batch endpoint or per-symbol? (c) free-tier rate limit + daily cap? (d) ToS for our scale? See `spec/signals/data-sources.md` → Universe coverage for the candidate list:

- **yfinance / Yahoo (unofficial)** — free, no key, has intraday OHLCV + daily volume. ToS-gray.
- **Polygon.io free tier** — 5 calls/min, aggregates + trades.
- **Alpaca Market Data (free IEX feed)** — bars + volume; free with account.
- **Twelve Data free** — 8 calls/min, 800/day; quotes with volume.

**Integration portion** (~half-day): write a small `services/universeQuote.ts` wrapper that pulls price+volume for the universe with whichever source the research picked, on the cadence the caching/staggering plan calls for (`spec/signals/screener-universe.md` → Caching + staggering). Extends `universe.last_price` + `universe.last_avg_volume` fields S1 already provisioned. **If no free-tier source qualifies**, S0.5 concludes "IB snapshot is the only viable source" — record that decision, plan IB-snapshot batched calls into the cron, accept the IB-budget cost.

### Files this batch creates/edits
- `docs/universe-data-research.md` (new) — research notes + decision record
- `server/src/services/universeQuote.ts` (new) — the integration wrapper, source-agnostic API
- `server/src/cron/universeCron.ts` (extend — wire the new wrapper for price/volume refresh; weekly cap+vol, daily price)
- `server/src/services/finnhub.ts` OR new provider file depending on research outcome
- `spec/signals/data-sources.md` (update the Universe-coverage section with the chosen source)

### Does NOT touch
- Trait scoring (S2), band engine (S3), FE (S4), or any IB-related code (unless IB-snapshot path is chosen as the fallback).

### Verification
- Research doc lists each candidate with measured free-tier behavior + a clear pick.
- After integration: `bin/upside-psql -c "select count(*) from universe where last_price is not null and last_avg_volume is not null;"` returns ≥ 90% of `filter_result='in'` count within 24h of cron.
- Daily provider call count stays within the chosen tier's free quota.

---

## Batch S1.5: Real IBKR conid resolution for universe tickers

**Depends on:** Batch S1 (universe table + synthetic-conid PK in place).

**Scope:** Replace the synthetic conids in S1's `universe` rows with **real IBKR conids** resolved via `ibSecdefSearch`. Without this, S2's trait scoring can't join `intraday_stats` (IB-keyed) and S2's `catalyst_reversal` can't pull `ibHistory`. ~45 min IB **once**, then cached forever per ticker; re-resolves only on universe additions. Spec: `spec/signals/screener-universe.md` → Conid resolution.

### Deliverables

1. **Migration `020_universe_real_conid.sql`** — add `real_conid bigint null` + `auto_promoted bool default false` columns to `universe`. Index on `real_conid` for join performance. (Matches `spec/schema.md` → universe.)
2. **`server/src/services/screener/conidResolver.ts`** — `resolveConid(symbol, mic)` that calls `ibSecdefSearch(symbol)`, filters to `secType=STK + currency=USD + exchange ∈ {NASDAQ, NYSE, AMEX}`, returns the primary-exchange match (or null if no STK match). First-listed tiebreaker for ambiguous cases (dual listings, A/B classes). Vitest fixtures for: clean single-match, multi-match w/ correct primary pick, no-match, non-STK-only response.
3. **`server/src/cron/conidResolutionCron.ts`** (or extension of universeCron) — daily pass: select universe rows where `real_conid IS NULL`, resolve in IB-rate-limited batches (~10/sec). One-time backlog ~45 min IB; steady-state near-zero (only new symbols).
4. **Optional one-shot kick** `npm run cron:resolve-conids` for the initial backlog flush.

### Files this batch creates/edits
- `supabase/migrations/020_universe_real_conid.sql` (new)
- `server/src/services/screener/conidResolver.ts` (new + vitest)
- `server/src/cron/conidResolutionCron.ts` (new) OR extend `universeCron.ts` with a resolution pass
- `server/src/index.ts` (boot wiring)
- `server/scripts/runConidResolutionCron.ts` (new) + `npm run cron:resolve-conids` script

### Does NOT touch
- Trait scoring (S2), band engine (S3), FE (S4). Pure data-layer slice.

### Manual prereqs
- IB connected during the initial backlog resolution (~45 min on first run; routine days are seconds).

### Verification
- Migration applied.
- After first full resolution pass: `bin/upside-psql -tAc "select 100.0 * count(real_conid) / count(*) from universe;"` returns ≥ **95%** (the ~5% unresolved are obscure types, delisted-since-Finnhub-pull, or genuine ambiguity).
- Spot-check: `bin/upside-psql -c "select symbol, conid, real_conid from universe where symbol in ('REPL', 'MNTS', 'RGTI');"` shows real conids matching the ones already in `watchlist_items` for the watchlist-overlap names.

---

## Batch S1: Stock universe + Ring 1 nightly cron

**Depends on:** Batch 13.7 (Finnhub rate-limited queue).

**Scope:** Production version of the universe scan + filter scoped in [Screener Slice 1 — scoping artifacts] (CLAIMS, 2026-05-30). New `universe` table maintained by a nightly cron. Foundation for S2/S3/S4 — without S1 there's nothing for trait scoring to score, no curated list for the band engine to walk, no rows for the FE tab to render. Spec: `spec/signals/screener-universe.md` (Ring 0, Ring 1, dynamic universe inclusion).

### Deliverables

1. **Migration `01X_universe.sql`** — `universe` table per `spec/schema.md` → `universe`. Service-role write, no user-facing reads needed (server-internal cache). Realtime NOT enabled (high churn, no FE consumer).
2. **`server/src/cron/universeCron.ts`** — runs at **09:00 IDT** (= 2 AM ET) nightly. Steps: Finnhub `/stock/symbol?exchange=US` (single call, cached for the day) → in-process type+MIC filter → per-conid `finnhubQueue.request('quote'|'profile', ...)` for the price+cap gate → upsert `universe` rows with `filter_result` set. Sleep cadence honors the existing queue's 50/min budget; full sweep ~100 min wall-clock at free-tier.
3. **`server/src/services/screener/universeFilter.ts`** — pure function tested via vitest (sample-of-survivors style fixtures from the scoping-script output).
4. **`server/src/services/finnhub.ts`** — extend with `getSymbolList()` (`/stock/symbol?exchange=US`) and `getProfile2(symbol)` (`/stock/profile2`) if not already present.
5. **Pre-market 15:30 IDT skeleton** — `universeCron` accepts a `mode: 'nightly' | 'premarket'` arg; the premarket pass refreshes price/cap on Ring-1-borderline tickers only (cheaper than full re-scan). Dynamic universe inclusion via 3× volume gap is **scaffolded but not wired** in S1 — the daily-bar pipeline that catalyst_reversal needs lands in S2, so the volume-gap promotion plugs in there.
6. **Retention**: rows with no `last_filter_pass` in 30 days deleted by a small daily retention task.
7. **Boot wiring** in `server/src/index.ts` to start the cron + an explicit `npm run cron:universe` one-shot for manual kicks.

### Files this batch creates/edits
- `supabase/migrations/01X_universe.sql` (new)
- `server/src/cron/universeCron.ts` (new)
- `server/src/services/screener/universeFilter.ts` (new)
- `server/src/services/finnhub.ts` (extend)
- `server/src/index.ts` (boot wiring)

### Does NOT touch
- Trait scoring (S2), band engine (S3), FE (S4).

### Verification
- Migration applied cleanly via Supabase SQL editor.
- After cron's first nightly run: `bin/upside-psql -tAc "select count(*) from universe where filter_result='in';"` returns a number within the **2,728–3,373** CI from the scoping sample (point ~3,051).
- `external_api_metrics` shows ≤ ~6,000 Finnhub calls for the sweep (≈ 2 calls per Ring-0 survivor) — within the free-tier 60/min × full-night budget.
- Manual `npm run cron:universe` triggers a one-shot pass.

---

## Batch S2: Screener — trait scoring engine

**Depends on:** Batch S1 (universe table), Batch S1.5 (real_conid resolution), Batch S0.5 (universe price+volume coverage), Batch B (existing `intraday_stats`).

**Scope:** The three traits (`intraday_range_trader`, `catalyst_reversal`, `post_earnings_drift`) and the `trait_scores` table they write to. Implements the **caching + staggering + event-gated** architecture from `spec/signals/screener-universe.md` → "Caching + staggering" so daily IB usage stays ~15-20 min (compatible with on-demand IBeam, not requiring 13.3). Discord first-fire notifications for the catalyst/earnings traits.

### Deliverables

1. **Migration `01X_trait_scores.sql`** — `trait_scores(conid, trait, asof_date, score, payload jsonb, computed_at, PRIMARY KEY (conid, trait, asof_date))` per `spec/schema.md`. Realtime enabled. Note: `conid` here references `universe.real_conid` (S1.5), not the synthetic PK.

2. **`server/src/services/screener/traits/intradayRangeTrader.ts`** — pure function reading `intraday_stats` rows (joined via `universe.real_conid`), applying threshold rules (p50 ≥ 2%, p25 ≥ 1%, sample_size ≥ 30, envelope-tightness ≤ 1.5, price-bonus for sub-$30). Vitest fixtures.

3. **`server/src/services/screener/traits/catalystReversal.ts`** — **three-stage** per spec:
   - **Stage 0**: pull Finnhub `/calendar/earnings` (today + last 3 days) + a daily `/news-sentiment` sweep over universe tickers showing prior-day news. Candidates = universe ∩ (had-news ∪ reported-earnings). ~100–300/day.
   - **Stage 1**: IB snapshot per Stage-0 candidate (~9 min IB). Flag those showing ≥3× vol vs `universe.last_avg_volume` AND ≥5% gap/intraday move.
   - **Stage 2**: `ibHistory(real_conid, '1y', '1d')` per Stage-1 hit (~5–50 tickers/day, ~1 min IB). Evaluate A ∧ B (beaten-down + confirmed wake-up). Survivors → `trait_scores` + set `universe.auto_promoted=true`.

4. **`server/src/services/screener/traits/postEarningsDrift.ts`** — Finnhub `/calendar/earnings` (one bulk call) + close-up-on-report-day test via `ibHistory(real_conid, '1m', '1d')` on each reporter (~10–50/day, ~1 min IB).

5. **Staggered `intradayStatsCron` extension** — change the cron from "iterate active watchlist conids" to "iterate `universe WHERE filter_result='in' AND real_conid IS NOT NULL AND real_conid mod 7 = day_of_week`" (plus continue covering watchlist conids for back-compat). Each ticker refreshes weekly; ~430 universe tickers/day × ~1 sec IB = ~7 min IB/day. Spec: `spec/signals/screener-universe.md` → Caching + staggering.

6. **Weekly market-cap refresh cron** (Sunday) — re-pulls Finnhub `/stock/profile2` for all `filter_result='in'` rows to update `last_market_cap_m` + `last_avg_volume`. ~50 min Finnhub / week. Filter re-evaluates at next nightly `universeCron` pass.

7. **Trait shelf-life retention**: drop `trait_scores` beyond shelf-life — 1 day for `intraday_range_trader`, 3 days for `catalyst_reversal`, 5 days for `post_earnings_drift`. Daily cleanup task.

8. **`services/notify.ts:notifyTraitFirstFire(trait, symbol, payload)`** — first-fire-per-(conid, trait, day) Discord ping. Routes `catalyst_reversal` + `post_earnings_drift` to `#upside-catalyst-alerts` (env `DISCORD_WEBHOOK_CATALYST_ALERTS`); `intraday_range_trader` is silent (baseline trait, would spam).

### Files this batch creates/edits
- `supabase/migrations/01X_trait_scores.sql` (new)
- `server/src/services/screener/traits/*.ts` (new — three trait functions + vitest)
- `server/src/cron/universeCron.ts` (extend with the scoring pass + Stage-0 news pre-filter for catalyst)
- `server/src/cron/intradayStatsCron.ts` (change target list to staggered universe set)
- `server/src/cron/marketCapRefreshCron.ts` (new — Sunday weekly cap+vol refresh)
- `server/src/services/notify.ts` (add `notifyTraitFirstFire`)
- `server/src/services/finnhub.ts` (extend with `/calendar/earnings`, `/news-sentiment` if not present)
- `.env.example` (add `DISCORD_WEBHOOK_CATALYST_ALERTS`)

### Does NOT touch
- Universe filter itself (S1), band engine (S3), FE (S4).

### Manual prereqs
- Create `#upside-catalyst-alerts` Discord channel + webhook → `DISCORD_WEBHOOK_CATALYST_ALERTS` to VPS `.env`.

### Verification
- Migration applied.
- After a cron run: `bin/upside-psql -c "select trait, count(*) from trait_scores where asof_date=current_date group by trait;"` shows three rows with non-trivial counts (intraday_range_trader likely 100s, others fewer).
- Live (Saturday → Monday spans a post-earnings window): `#upside-catalyst-alerts` fires one ping per qualifying ticker per day; no duplicate fires for the same ticker on the same day.

---

## Batch S3: Improved entry engine — adaptive band layers

**Depends on:** Batch S2 (`intraday_range_trader` trait gives us the curated list), Batch B (`intraday_stats` is the static baseline).

**Scope:** The three adaptive layers on top of the static `intraday_stats` band — `session_regime` classifier, today's `vol_scalar`, walking band-state machine. The improvement over the existing entry-zone engine: bands adapt to today's gap + today's realized volatility + today's pivots instead of being frozen at open. Spec: `spec/signals/band-engine.md`.

### Deliverables

1. **Migration `01X_band_state.sql`** — `band_state(conid, session_date, anchors jsonb, current_low_band, current_high_band, session_regime, vol_scalar, vol_regime_shift, updated_at, PRIMARY KEY (conid, session_date))` per `spec/schema.md`. Realtime enabled (FE band chips subscribe).
2. **`server/src/services/bandEngine/sessionRegime.ts`** — Layer 1 classifier (gap + first-15-min direction + pre-mkt volume → `mean_reversion | bullish_trend | bearish_trend | mixed`). Pure function + vitest fixtures (typical / trend / mixed).
3. **`server/src/services/bandEngine/volScalar.ts`** — Layer 2: `ATR(last 12 5min bars) / ATR_30d_baseline` → band-width multiplier + annotation enum (`high_vol_today` / `calm_day` / null). Pure function + vitest. **Validated empirically 2026-05-30**: this layer would have widened MNTS's band to cover the actual low ($16.00 vs predicted $17.96).
4. **`server/src/services/bandEngine/walkingState.ts`** — Layer 3: state machine with re-anchor on observed reversal from running extremum (threshold = `0.5 × intraday_ATR`). Both bands recompute on every anchor. No chain-length limit. Pure function + vitest with multi-leg scenario fixtures (REPL-style scalp pattern: 4 buy/sell legs in one session).
5. **`server/src/services/bandEngine/volRegimeShift.ts`** — daily flag (last 5 sessions ATR > 2× prior 30d ATR) — the cheap correctness hedge per spec; just sets the flag + annotation, does NOT auto-truncate the lookback (that's a Track-10 deferred item).
6. **`server/src/cron/bandEngineCron.ts`** — runs every 5 min during **16:30 IDT – 03:00 IDT** (regular session + AH) on the curated list (`intraday_range_trader` survivors, ~100 tickers). 15:45 IDT fires session_regime classifier; ticks thereafter run vol_scalar + walkingState. AH walking annotates `session_regime = 'ah_low_confidence'`.
7. **Reset task at 16:30 IDT next session** — clears anchors, resets regime. Same cron file; mode-flag invocation.
8. **`services/notify.ts:notifyBandTouchLow` / `notifyBandTouchHigh`** — band-touch Discord notifications. Low-touch on curated (not held) → `#upside-dip-buys` (existing channel). High-touch on held position → new `#upside-sell-zones` (env `DISCORD_WEBHOOK_SELL_ZONES`). 4h cooldown per `(conid, band_kind)` via a `band_touch_last_fired_at` jsonb field on `band_state`.

### Files this batch creates/edits
- `supabase/migrations/01X_band_state.sql` (new)
- `server/src/services/bandEngine/*.ts` (new — sessionRegime, volScalar, walkingState, volRegimeShift + vitest)
- `server/src/cron/bandEngineCron.ts` (new)
- `server/src/services/notify.ts` (add `notifyBandTouchLow` / `notifyBandTouchHigh`)
- `.env.example` (add `DISCORD_WEBHOOK_SELL_ZONES`)

### Does NOT touch
- Universe (S1), trait scoring (S2), FE (S4).

### Manual prereqs
- Create `#upside-sell-zones` Discord channel + webhook → `DISCORD_WEBHOOK_SELL_ZONES` to VPS `.env`.

### Verification
- Migration applied.
- During regular session: `bin/upside-psql -c "select conid, session_regime, vol_scalar, jsonb_array_length(anchors) from band_state where session_date=current_date order by jsonb_array_length(anchors) desc limit 10;"` shows curated tickers with regime labels + walking anchors growing through the session.
- Band-touch Discord pings fire on first touch + are suppressed on subsequent touches within 4h.
- MNTS-style cases: when `vol_regime_shift = true`, the published band is visibly wider than the static `intraday_stats` band would have been.

---

## Batch S4: Virtual lists — Screener tab FE

**Depends on:** Batch S2 (`trait_scores`), Batch S3 (`band_state`).

**Scope:** New Screener tab in the bottom nav with vertical accordions per trait, walking-band annotation chips, and a promote-to-watchlist affordance. The user-facing endpoint of the screener track — the place where you SEE the discovered tickers. Spec: `spec/screens/screener.md`.

### Deliverables

1. **`client/src/pages/Screener.tsx`** (new) — top-level page; loading-state-fix pattern (header always visible, body shows skeleton + per-trait loading).
2. **`client/src/components/common/BottomNav.tsx`** — add Screener tab (4 tabs total: Portfolio · Watchlist · **Screener** · Settings).
3. **`client/src/routes.tsx`** — add `/screener` route.
4. **`client/src/components/Screener/*`** (new):
   - `TraitAccordion.tsx` — collapsible per-trait section; top-5 rows default + "Show all 30" expand. Section order: catalyst_reversal first when populated, range-traders default, drift last.
   - `ScreenerRow.tsx` — uses the existing `TickerCard` primitive in `variant='screener'`. PriceFlicker wraps the price. Trait-specific chip cluster: `IntradayStatsChip` + "$X.XX band" for range-trader; gap multiplier + intraday move + beaten-down basis for catalyst_reversal; days-since-earnings + report-day pop for post_earnings_drift.
   - `BandAnnotationChip.tsx` — small chip showing `session_regime` + `vol_scalar` annotation. Tap → opens popover with next predicted low/high bands. (Reuses the existing entry-zone popover styling pattern from Watchlist.)
   - `PromoteSheet.tsx` — long-press / right-click on a row → sheet with "Add to Watchlist" + "Set marker" actions; the marker action prefills the price from the band engine's published p50 buy band.
   - `ScreenerSettingsSheet.tsx` — gear icon → visible-traits toggles, top-N list size, sort (score / price / alphabetical), "hide tickers in my Watchlist" toggle.
5. **`client/src/hooks/useScreenerData.ts`** — Supabase Realtime subscription on `trait_scores` + `band_state`, joined with `universe` + `contracts` for symbol/name lookup. Returns `tickersByTrait` shape ready to render.
6. **Empty state**: "The screener is still warming up." (renders when no `trait_scores` rows exist for today). Refresh sub-row in header shows last-refresh timestamp.
7. **Per-screen settings persist in localStorage** for v1 (Batch 15 will move them to `user_preferences.stat_config`-style — small follow-up migration).
8. **CSS** for screener-specific blocks in `client/src/styles/components.css`.

### Files this batch creates/edits
- `client/src/pages/Screener.tsx` (new)
- `client/src/components/common/BottomNav.tsx`
- `client/src/routes.tsx`
- `client/src/components/Screener/*.tsx` (new)
- `client/src/hooks/useScreenerData.ts` (new)
- `client/src/styles/components.css` (Screener-specific blocks)

### Does NOT touch
- Any signal-engine code, any cron, any schema. Pure FE consumer of S1+S2+S3 outputs.

### Verification
- New "Screener" tab visible in BottomNav.
- Tapping it shows three accordions (catalyst_reversal at top when populated, range-traders default, drift last).
- Each row shows trait-specific chips + walking-band annotation chip when `band_state` has data.
- Tap a band chip → popover with next-low and next-high bands.
- Long-press → promote sheet works; "Add to Watchlist" writes a `watchlist_items` row; the new ticker appears in Watchlist on next render.
- Loading state shows header + accordion shells (not a whiteout — follows the loading-state pattern shipped 2026-05-30).

---

## Batch C (sketch): post-Batch-B alert tuning + cross-source feedback

**Depends on:** A few live days of A2 + A+ + B alerts firing.

**Why a sketch:** the tuning decisions need real Discord traffic to settle — which channels feel noisy vs. silent, whether `at_or_above` and `about` markers warrant their own channel, whether the stats band should fire on cross-into or also on "still inside after N min". Don't claim this batch until the user has eyeballed at least a week of live alerts.

### Pending decisions (settle when claiming)
- Are dip-buy + stats-alerts firing at roughly the cadence the user wants, or do we need cooldown changes / debounce / quiet hours?
- Does `at_or_above` get a `#upside-targets` channel now, or stay queued?
- Does `about` get a channel + ATR-band tuning?
- Should entry-zone alerts split from `#upside-dip-buys` into their own channel?
- Watchlist-row polish round 6: anything still cramped after the round-5 layout converged?

### Deliverables (sketch)
1. Per-condition channel routing if decided (`at_or_above` → `#upside-targets`, etc.).
2. Per-marker cooldown UI (the schema field exists; the FE control doesn't).
3. Stats-alert second trigger ("still in band 10 min later") if cross-into proves too sensitive.
4. Any FE polish slices that emerge.

---

## Batch 13.2: Generic IB passthrough debug endpoint

**Depends on:** Batch 13 (live IB available via IBeam).

**Scope:** A single auth-gated, read-only, allowlist-enforced HTTP endpoint that proxies any IB Client Portal path the user supplies and returns the raw response untouched. Lets us pull live IB data shapes from the laptop with one `curl`, without spinning up the local Client Portal Gateway and re-authenticating in a browser. Strictly debug infrastructure; no FE surface.

**Why now (not post-MVP):** post-MVP Watchlist track will need to inspect the real shape of `/v1/api/iserver/watchlists` and friends to lock the schema. Having this tool available *during* MVP work means we can capture watchlist payloads any time without blocking on post-MVP starting. The endpoint is tiny (~50-100 lines), strictly debug-only, and doesn't expand MVP user-facing scope.

### Deliverables

1. **New route** `GET /api/debug/ib-passthrough?path=<IB-PATH>[&...querystring]` in `server/src/routes/debug.ts`:
   - **Auth-gated**: requires Bearer token from a whitelisted email. Non-whitelisted bearers → 403. Anonymous → 401.
   - **IB session required**: if IBeam container is not running or session not authenticated → 503 with `{ reason: 'ib_not_connected' }`.
   - **Path allowlist enforced**: the `path` query param must match one of an explicit allowlist of safe, read-only IB endpoints. Any other path → 400 with `{ reason: 'path_not_allowed', allowed: [...] }`.
   - **Method is GET only.** No body. No way to POST / PUT / DELETE through this endpoint.
   - **Response**: the raw IB response, content-type preserved, status code preserved (so 4xx/5xx from IB pass through transparently for debugging).

2. **Allowlist** (in `server/src/services/ibPassthroughAllowlist.ts`) — explicit list of regexes matching safe IB Client Portal paths. Initial set:
   ```
   ^/v1/api/iserver/accounts$
   ^/v1/api/iserver/account/[^/]+/summary$
   ^/v1/api/iserver/auth/status$
   ^/v1/api/iserver/contract/\d+/info$
   ^/v1/api/iserver/marketdata/history$
   ^/v1/api/iserver/marketdata/snapshot$
   ^/v1/api/iserver/secdef/search$
   ^/v1/api/iserver/watchlists$
   ^/v1/api/iserver/watchlist$
   ^/v1/api/portfolio/accounts$
   ^/v1/api/portfolio/[^/]+/ledger$
   ^/v1/api/portfolio/[^/]+/positions/\d+$
   ^/v1/api/portfolio/[^/]+/summary$
   ^/v1/api/portfolio/[^/]+/transactions$
   ^/v1/api/tickle$
   ```
   **Explicitly forbidden** (never add to allowlist, document why): anything under `/v1/api/iserver/account/[^/]+/orders`, `/v1/api/iserver/reply/`, `/v1/api/iserver/scanner/`, or any path containing `order` / `place` / `cancel` / `modify`. Order operations would let a compromised auth token execute trades. Even though the IB allowlist is positive (only listed paths pass), document this rule in `ibPassthroughAllowlist.ts` so future additions don't accidentally cross the line.

3. **Logging**: every passthrough call logs `{ caller_email, path, status, duration_ms }` to `external_api_metrics` with `provider: 'ib'` and a marker tag (e.g. `endpoint: 'debug-passthrough:<path>'`). Treats this surface as auditable from day one.

4. **Local capture workflow**: user runs from laptop:
   ```bash
   TOKEN=$(... fetch from Supabase session, or paste from browser dev tools)
   API_URL=https://<current-vercel-or-tunnel-url>

   curl -sS -H "Authorization: Bearer $TOKEN" \
     "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlists" \
     > captures/watchlists-$(date -u +%Y-%m-%d).json

   curl -sS -H "Authorization: Bearer $TOKEN" \
     "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlist&id=<wl_id>" \
     > captures/watchlist-<id>-$(date -u +%Y-%m-%d).json
   ```
   Files land in the gitignored `captures/` directory (already established in Batch 7).

5. **README note** in `server/README.md` or a new `docs/debug.md` documenting the endpoint, the allowlist policy, the curl workflow, and the security model.

### Files this batch creates/edits
- `server/src/routes/debug.ts` (new)
- `server/src/services/ibPassthroughAllowlist.ts` (new)
- `server/src/index.ts` (mount the debug route)
- `server/src/services/ibGateway.ts` (potentially add a generic `ibRawGet(path, query)` helper if one isn't already exposed)
- `docs/debug.md` (new, brief)

### Does NOT touch
- Any FE files.
- Any production routes or business logic.
- Schema.
- Discord.

### Manual prerequisites
- None new — uses existing whitelisted-email auth and the already-running IBeam.

### Verification
- Whitelisted email + connected IB + allowlisted path → JSON response from IB.
- Whitelisted email + connected IB + non-allowlisted path (e.g. `/v1/api/iserver/account/<id>/orders`) → 400 `path_not_allowed`.
- Non-whitelisted bearer → 403.
- No bearer → 401.
- IB disconnected → 503 `ib_not_connected`.
- Method other than GET → 405.
- After a few captures, `external_api_metrics` shows audit rows tagged `debug-passthrough:*`.

### Acceptance use-case (proof of utility, runs during this batch as the verification capstone)
- Capture `/v1/api/iserver/watchlists` and one specific `/v1/api/iserver/watchlist?id=<id>` from live IB.
- Paste the file list back into the chat with Claude so the post-MVP Watchlist track's data model can be locked against real shapes ahead of when its batch is built.

---

## Batch 13.3: Secondary IBKR user + desired-state IBeam toggle

**Status: ON HOLD — pending IBKR support inquiry.** Per IBKR policy, "the account will be assessed a separate market data subscription fee for each user account added" and "user account market data subscriptions are tied to and cannot vary from that of the account holder." Unclear whether the **free** Cboe One + IEX real-time US streaming (the entitlement MVP relies on) is doubled in cost or stays free for a 2nd user. Verify with IBKR support before claiming. Open IBeam-side question too: [Voyz/ibeam#137](https://github.com/Voyz/ibeam/issues/137) — no community validation of the secondary-user pattern with IBeam yet.

**Depends on:** Batch 13.

**Scope:** Two changes that ship together:
1. Create a second IBKR username on the same account and swap IBeam to use it. IBKR's single-session limit is per *username*, not per account — the secondary user holds a continuous session for Upside while the primary stays free for IBKR Mobile. Eliminates the "battle royale" risk that drove the on-demand model in Batch 13.
2. Replace the imperative Connect/Disconnect FE buttons with a **desired-state toggle**. FE writes "should be on" or "should be off" to `app_config`; a backend reconciler continuously drives the `ib-gateway` container to match. Default desired state = `'on'`, so the always-on behavior takes effect automatically after deploy. The toggle stays available for maintenance, debugging, or freeing the session intentionally.

**Why this and not the alternatives:** Read-only Portal-tier sessions (skip `/iserver/auth/ssodh/init`) coexist with IBKR Mobile but lose `/iserver/marketdata/*` (snapshot, history). IBC's `ReadOnlyLogin=yes` is a TWS UI mode, not a server-side session class — still claims a brokerage session and conflicts the same way. A second username is IBKR's own recommended pattern for this use case, requires no fork, and keeps full Client Portal API access. The desired-state toggle is a cleaner replacement for the imperative endpoints than deleting them outright: same FE affordance the user already likes, but the reconciler makes it self-healing (e.g. survives nightly forced logout without user action when desired=on).

### Deliverables

**Manual (user):**
1. In IBKR Account Management: add a secondary user on the same account. Pick a read-only/view-only role template if offered (still works if not — IBeam doesn't trade either way). Enroll the new user in 2FA; prefer TOTP over IB Key push so IBeam can automate login without a phone tap.
2. Verify market data is accessible on the new user (free Cboe One + IEX real-time on US stocks is sufficient for MVP).
3. On the VPS, replace `~/upside/secrets/ib_account.txt` and `~/upside/secrets/ib_password.txt` with the new user's credentials. Keep `chmod 0400`.

**Code — compose / config:**
4. `docker-compose.yml`: remove `profiles: [manual]` from `ib-gateway` so it boots with the stack. Set `IBEAM_RESTART_FAILED_SESSIONS=True` and flip `IBEAM_AUTHENTICATION_STRATEGY` to `B` — both were turned off in Batch 13 specifically to avoid the battle royale; safe to re-enable now that the username is dedicated. Even with these on, the reconciler (deliverable 7) is what *starts* the container; IBeam's restart loop only handles re-auth within an already-running container.

**Code — desired-state toggle:**
5. Migration `supabase/migrations/00X_ib_desired_state.sql`: insert `('ib_desired_state', 'on')` into `app_config` if not present. Idempotent. New deploys come up with the container already targeted to run.
6. `POST /api/auth/ib/desired-state` (body: `{ on: boolean }`) in `server/src/routes/auth.ts`:
   - Auth-gated (whitelisted email).
   - Writes `ib_desired_state` value to `app_config`.
   - Returns 200 immediately with the persisted state (the "received" ack). Does NOT block on container action.
   - Kicks the reconciler so it doesn't have to wait for its next tick.
   - Replaces the imperative `POST /api/auth/ib/connect` and `/disconnect` endpoints — both removed in this batch.
7. `server/src/services/ibReconciler.ts` (new):
   - Loop every ~10s, plus on api startup, plus woken by the desired-state POST.
   - Reads `ib_desired_state` from `app_config` and current container state from Docker.
   - desired=on, actual=stopped → `docker start ib-gateway`.
   - desired=off, actual=running → `docker stop ib-gateway`.
   - desired=on, actual=running → no-op; IBeam's own `RESTART_FAILED_SESSIONS=True` handles re-auth within the container.
   - Exponential backoff on repeated start failures (cap ~5 min between attempts) so bad creds don't churn the container.
   - On sustained start failure: surface via existing status indicator (red + short reason) and one Discord critical ping per failure streak (not per attempt).

**Code — frontend:**
8. `client/src/components/common/IbStatusIndicator.tsx` refactor:
   - Replace Connect / Disconnect / Cancel buttons with a single toggle (on/off).
   - Toggle reflects *desired* state, read from `app_config` via Supabase Realtime (so multi-device toggles stay in sync).
   - Status dot continues to reflect *actual* state (green/amber/red) — unchanged logic.
   - Tap → optimistic flip → `POST /api/auth/ib/desired-state` → on error, revert + toast.
9. `client/src/hooks/` (or wherever `app_config` is already subscribed): extend the existing `app_config` Realtime subscription from Batch 11 to also surface `ib_desired_state`.

**Code — spec:**
10. `spec/architecture.md`: rewrite the "IB Authentication Flow" section. Replace the on-demand narrative with the two-username + desired-state toggle + reconciler model. Document that the toggle defaults to `on` and most users never touch it.
11. `spec/archive.md`: move the on-demand explanation + rationale here with the note "superseded by Batch 13.3 (secondary user + desired-state toggle)."

### Files this batch creates/edits
- `~/upside/secrets/ib_account.txt`, `~/upside/secrets/ib_password.txt` (manual, on VPS)
- `docker-compose.yml`
- `supabase/migrations/00X_ib_desired_state.sql` (new)
- `server/src/routes/auth.ts` (replace connect/disconnect with desired-state endpoint)
- `server/src/services/ibReconciler.ts` (new)
- `server/src/index.ts` (start the reconciler on boot)
- `server/src/services/ibContainer.ts` (likely keep the start/stop primitives, called from the reconciler instead of the routes)
- `client/src/components/common/IbStatusIndicator.tsx`
- `spec/architecture.md`, `spec/archive.md`

### Does NOT touch
- IBeam itself (no fork, no env-var overrides beyond the two flipped flags).
- pricePoller / Finnhub fallback (Finnhub stays as a defense-in-depth fallback per Batch 13.8 even though IB will now be up continuously).
- `app_config` schema (existing key/value table from Batch 11 — just a new key).

### Verification

**Always-on path (typical case):**
- After deploy: `ib_desired_state = 'on'` (default). Reconciler starts the container without any user action. `docker compose logs ib-gateway | grep -i authenticated` shows successful login.
- Supabase `positions.last_price_update_at` updates continuously with `price_source = 'ib'` at the adaptive cadence.
- IBKR Mobile logged in on the primary user shows portfolio normally, no interruption.
- Open IBKR Mobile, navigate for 5+ min → Upside keeps updating, IBKR Mobile not kicked out.
- Survives one nightly forced logout (~11:45 PM ET) → next morning IBeam has auto-relogged via TOTP without intervention.

**Toggle path:**
- Tap toggle off in FE → `app_config.ib_desired_state` flips to `'off'` (verify via Supabase). Within ~10s reconciler stops the container. Status dot goes red. Finnhub fallback keeps prices reasonably fresh.
- Tap toggle back on → desired-state flips to `'on'`, reconciler starts the container within ~10s, status dot goes amber then green.
- On a second device, the toggle position updates via Realtime within ~1s of the first device's tap.
- Kill the api mid-cycle → on restart, reconciler reads desired-state and immediately re-syncs the container.

**Failure path:**
- Temporarily corrupt `ib_password.txt` → reconciler attempts start, IBeam fails to auth, container exits → reconciler backs off exponentially (not a tight loop). Status dot shows red + reason; Discord critical ping fires once for the failure streak.
- Fix the password → next reconciler tick succeeds; status returns to green.

---

## Batch 13.5: Verify & implement `tradingDaysHeld` + MTD return

**Depends on:** Batch 13.1.

**Scope:** Two metrics flagged "⚠ Verification pending" in the spec — both currently unverified live. Resolve both, implement whichever is missing. After this batch, the spec's verification markers can be removed.

### Deliverables

1. **`tradingDaysHeld`** — for each held position, count of US trading days since entry:
   - First investigation: query IB's transactions endpoint (`/v1/api/portfolio/<acctId>/transactions` — confirm exact name) for transaction history per held conid. Confirm response shape gives reliable entry dates including for positions held >1 year.
   - If reliable: implement in `server/src/services/ibGateway.ts:ibTradingDaysHeld(conid)`, called by `pricePoller` once per position per session (cache result, only re-fetch if shares changed).
   - If unreliable for older positions: fall back to Upside-tracked entry-date (write `first_seen_at` on `positions` when a new conid first appears, use that). Older positions show "≥N days" until the user's next change-in-shares event.

2. **MTD return** — month-to-date portfolio return percent:
   - First investigation: query IB's account summary (`/v1/api/portfolio/<acctId>/summary` or `/v1/api/iserver/account/<acctId>/summary` — confirm) for an MTD field.
   - If present: surface via `GET /api/portfolio/summary` to the FE.
   - If absent: implement via Redis-cached `portfolio_value_month_start` (set on first poll of each new month, never overwritten until the next month begins). MTD = `(current - cached) / cached`. Persists across api restarts via Redis durability.

3. **FE wire-up**:
   - `tradingDaysHeld` → `PositionStats` section's "Days held" row and `daysHeld`-derived "Return per day" row.
   - MTD return → `SummaryStrip` right card.
   - Both should render with reasonable fallback states (e.g. "—" if data unavailable rather than crashing).

### Files this batch creates/edits
- `server/src/services/ibGateway.ts`, `server/src/services/redis.ts` (month-start cache helper if needed), `server/src/routes/portfolio.ts`, `server/src/cron/pricePoller.ts` (capture month-start), possibly `supabase/migrations/00X_position_first_seen.sql` (if IB transactions unreliable), `client/src/components/TickerDetail/PositionStats.tsx`, `client/src/components/PortfolioHome/SummaryStrip.tsx`.

### Does NOT touch
- Signal engine, Discord, zone detection.

### Verification
- Portfolio screen shows real MTD return value (not "—" or placeholder).
- Open any held position's detail → PositionStats shows real days-held + computed %/day.
- Document the verification findings in the commit message / claim notes so the spec's "⚠ Verification pending" markers can be removed.

---

## Batch 13.7: Finnhub rate-limited request queue

**Depends on:** Batch 13.

**Scope:** Build the queue infrastructure that all future Finnhub callers will use. No actual Finnhub features added in this batch — just the plumbing. Per-category cadence tuning happens in Batch 13.9 once real callers exist.

### Deliverables

1. **`server/src/services/finnhubQueue.ts`**:
   - Token-bucket limiter, 50 calls/min global (configurable via env `FINNHUB_RATE_LIMIT_PER_MIN`, default 50). 10-call buffer below Finnhub's 60/min free-tier ceiling.
   - Per-category min-interval-per-key support. Categories: `quote`, `candle`, `news`, `insider`, `earnings`, `profile` (extensible). Config map; default all categories to 0s min-interval (no throttle) for this batch — tuning happens in 13.9.
   - **No stale-cache returns** — requests for the same `(category, key)` within an in-flight or recent same-pair request **wait for the next eligible slot**, then get fresh data. Worst-case wait equals the category's min-interval.
   - FIFO ordering within a category; global token bucket shared across categories.
   - Exponential backoff + 1 retry on 429 (defensive only).
   - Exposed API: `finnhubQueue.request<T>(category, key, fn: () => Promise<T>): Promise<T>`.

2. **`server/src/services/finnhub.ts`** — existing stub gets a small refactor: every existing or skeleton Finnhub call goes through `finnhubQueue.request()`. Even if some functions are stubs, the queue wrapper is in place so 14a/14b can use them directly.

3. **Metrics table — rename or extend `ib_api_metrics` → `external_api_metrics`** (add a `provider text not null` column, default `'ib'` for existing rows). Instrument each Finnhub call same as IB: endpoint/category, duration_ms, status, retries. Lightweight; foundation for future per-category cadence tuning.

### Files this batch creates/edits
- `server/src/services/finnhubQueue.ts` (new), `server/src/services/finnhub.ts` (refactor to route through queue), `server/src/env.ts` (add `FINNHUB_RATE_LIMIT_PER_MIN`), `supabase/migrations/00X_external_api_metrics.sql` (rename or extend the IB metrics table).

### Does NOT touch
- Any feature consumer of Finnhub (those come in 14a/b/d).

### Verification
- Unit-test or manual: fire 100 requests in a tight loop through the queue, confirm fan-out respects 50/min and no Finnhub 429s.
- `external_api_metrics` shows rows for any test calls made.

---

## Batch 13.8: Multi-source price polling (IB primary, Finnhub fallback)

**Depends on:** Batch 13.7.

**Scope:** Make `current_price` updates IB-independent. When IB is connected, use IB. When IB is off, fall back to Finnhub quote endpoint via the queue. Both sources write to the same `positions` row. This is what makes the on-demand IBeam model actually viable as a daily-use product — the user can leave IB off and still see fresh-enough data.

### Deliverables

1. **Schema (`supabase/migrations/00X_price_source.sql`)**:
   - Add `price_source text not null default 'ib'` to `positions` (enum-like: `'ib' | 'finnhub'`).
   - Add `last_price_update_at timestamptz null` to `positions` (used by Finnhub poller to decide whether to skip).

2. **`server/src/cron/pricePoller.ts`** — split / rename:
   - `ibPricePoller`: keeps existing adaptive cadence (10s / 60s / 5min based on market period). Writes with `price_source: 'ib'` and updates `last_price_update_at`. Runs only when IB session `connected`.
   - `finnhubPricePoller`: new. 60s cadence, always-on. For each held position, if `last_price_update_at` is null or older than 90s, fetch quote via `finnhubQueue.request('quote', symbol, ...)` and write with `price_source: 'finnhub'`.

3. **Optional FE indicator (cheap to add now, deferred render):** PositionCard accepts `priceSource` prop. Default: render nothing extra. Behind a feature flag, render a small "F" badge near the price when source is Finnhub. Useful for debugging but no need to expose to user yet.

### Files this batch creates/edits
- `server/src/cron/ibPricePoller.ts` (renamed from / split off pricePoller.ts), `server/src/cron/finnhubPricePoller.ts` (new), `server/src/services/finnhub.ts` (add `getQuote(symbol)`), `supabase/migrations/00X_price_source.sql`, optional small PositionCard prop addition.

### Does NOT touch
- Signal engine, zone detection (those come in 14a/14c respectively but consume what this batch provides).

### Verification
- IB connected: positions update every 10-60s with `price_source = 'ib'`.
- Disconnect IB via FE button → wait 90s → Supabase shows positions still updating, `price_source = 'finnhub'`.
- Reconnect IB → next IB poll wins → `price_source` returns to `'ib'`, Finnhub poller goes idle.

---

## Batch 14a: Signal engine + manual unified analysis end-to-end

**Depends on:** Batch 13.1, 13.5, 13.7.

**Scope:** The brain. User taps Analyze → 10-15s later one unified analysis lands in Supabase — both SELL and BUY directions evaluated, both rendered on TickerDetail when present. Replaces the original Batch 14 in the queue; split into 14a (engine) and 14b (accuracy) for cleaner scope. Reflects the post-Batch-13 decision to make all MVP analyses unified (see UPSIDE_MVP_SPEC.md → "Signal Model").

### Deliverables

#### Backend

1. **Schema additions (`supabase/migrations/00X_unified_signals.sql`)**:
   - New `analyses` table: `{ analysis_id uuid pk, user_id uuid, symbol text, conid bigint, indicator_snapshot jsonb, reasoning text, analyzed_at timestamptz, expires_at timestamptz }`. Holds shared analysis context.
   - Alter `signals` table:
     - Drop the legacy `signalType` `'sell' | 'no_signal'` check constraint; widen to `'sell' | 'buy' | 'no_signal'`.
     - Add `analysis_id uuid not null references analyses(analysis_id)`.
     - Add `motivation text null` — `'take_profit' | 'derisk' | 'avoid_downside'` for SELL; `'pullback_entry' | 'breakout_continuation' | 'value'` for BUY; null for `no_signal`.
     - Add `rationale text null` — direction-specific reasoning bullet (the overall narrative lives on `analyses.reasoning`).
   - Index `signals(user_id, symbol, analyzed_at desc)` for the "latest non-superseded" query.

2. **Provider implementations in `server/src/services/llm.ts`**:
   - Real `GeminiProvider.analyze(context)` using Gemini API.
   - Stubs for `ClaudeProvider` / `OpenAiProvider` that throw a clear error pointing to the relevant env var.

3. **`server/src/services/signalEngine.ts`** (new) — orchestrates a single unified analysis:
   - Acquire `analysis_locks` row (TTL 5 min — see step 8).
   - Ensure `contracts` cache row exists (lazy-fetch).
   - Pull intraday + daily history from IB; compute RSI, MACD, Bollinger, VWAP via `technicals.ts`.
   - Pull current snapshot via `ibGateway.ibSnapshot`.
   - Pull news / earnings / insider data via Finnhub (through the queue).
   - **Read position's zone state** (`zone_entered_at`, `entered_zone_via_gap` — fields exist post-Batch-14c, null-safe before then). If `inZone`: populate `contextualTriggers.inProfitTakingZone`.
   - Assemble structured LLM prompt. The prompt requests **unified analysis: indicator readings, narrative reasoning, then nullable `sellSignal` and `buySignal` blocks**. Both nulls is valid output (no actionable signal in either direction). `contextualTriggers` section reserved in prompt structure for future trigger types.
   - Call `llm.analyze()`.
   - **Zod-validate the LLM response.** On malformed: retry once with a stricter prompt. On second failure: write one `signals` row with `signalType: 'no_signal'` and reason "LLM response malformed", linked to a parent `analyses` row, then release lock.
   - On valid response: insert one `analyses` row, then 1-2 `signals` rows (one for each non-null direction; or one `no_signal` row if both null).
   - **Supersede prior analyses**: for the same `(user_id, symbol)`, update all prior non-superseded `signals` rows: `superseded_by_analysis_id = <new analysis_id>`. Whole-analysis supersede semantics regardless of which directions filled in (see spec).
   - Release lock.

4. **`server/src/services/technicals.ts`** — full implementations: `rsi()`, `macd()`, `bollinger()`, `vwap()`. Use `technicalindicators` npm package.

5. **`server/src/services/finnhub.ts`** — flesh out `getCompanyNews`, `getInsiderTransactions`, `getEarningsCalendar` (all through the queue).

6. **`server/src/routes/signals.ts`** — replace the 501 stub with a real handler:
   - **Re-analyze soft-block**: check if an `analyses` row exists for `(user_id, symbol)` with `analyzed_at` within last 5 min. If yes: return `429` with `{ lastAnalyzedAt, reason: 'recent_analysis' }`. FE re-sends with `force: true` to bypass.
   - **Daily cost ceiling**: env var `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis keyed `llm_calls:YYYY-MM-DD` with midnight-UTC TTL. If exceeded: return 429 with `{ reason: 'daily_limit_reached' }`. **Each unified analysis counts as one call**, regardless of how many signals it produces.
   - Invoke `signalEngine.analyze()` async, return 202 immediately. FE subscribes to `signals` Realtime to detect completion.

7. **Note on idempotency**: explicitly **NOT** adding idempotency keys. The `analysis_locks` row already prevents concurrent double-runs.

8. **Analysis lock TTL bumped to 5 min**: cron `lockCleanup.ts` cleans rows older than 5 min.

#### Frontend

9. **`client/src/components/TickerDetail/SignalSection.tsx`** — wire to real signal data via Supabase Realtime. Latest non-superseded analysis's signal rows render: shared `indicator analysis` + `reasoning` header (from the `analyses` row), then per-direction blocks below (SELL block if `sellSignal` row exists, BUY block if `buySignal` row exists, "no signal: <reason>" if `no_signal`). "View history" expands the chronological list across `analyses`.

10. **`client/src/hooks/useAnalysisLock.ts`** — subscribe to `analysis_locks` for the active (user, symbol) → disable Analyze button when locked.

11. **Two-step Analyze button (per spec)**: tap → grey out 1s → "Confirm analyze" → tap again → POST `/api/signals/analyze`.

12. **Re-analyze soft-block UI**: on 429 with `reason: 'recent_analysis'` + `lastAnalyzedAt`, render confirm prompt. On Yes, re-POST with `force: true`.

13. **Daily-limit-reached UI**: on 429 with `reason: 'daily_limit_reached'`, show inline "Daily analysis limit reached — resets at midnight UTC" and disable button until then.

14. **`SignalPill` primitive** (in `client/src/components/primitives/SignalPill.tsx`): renders `[<type> · <quality>% · <motivation> · $<low>-<high>]`. Used on TickerCards by both held and watchlist variants. Colors per `signalType`: SELL red, BUY green, no_signal gray. Both pills can render simultaneously on a card.

### Files this batch creates/edits
- `supabase/migrations/00X_unified_signals.sql` (new — analyses table + signals schema changes)
- `server/src/services/llm.ts`, `server/src/services/signalEngine.ts` (new), `server/src/services/technicals.ts`, `server/src/services/finnhub.ts`, `server/src/services/redis.ts` (LLM cost counter helpers), `server/src/routes/signals.ts`, `server/src/cron/lockCleanup.ts` (renamed from signalRunner.ts, 5-min TTL)
- `client/src/components/TickerDetail/SignalSection.tsx`, `client/src/hooks/useAnalysisLock.ts`, `client/src/hooks/useSignals.ts`, `client/src/components/primitives/SignalPill.tsx` (new)

### Manual prerequisites (user)
- Get Gemini API key at aistudio.google.com → add `GEMINI_API_KEY` to VPS `.env`.
- Get Finnhub API key at finnhub.io → add `FINNHUB_API_KEY` to VPS `.env`.
- `docker compose restart api`.

### Verification
- Tap Analyze on a held position → 1s greyed → tap again → ~10-15s later TickerDetail's Signal Section renders with shared indicators + reasoning header, plus per-direction block(s) for whichever of SELL / BUY the LLM emitted.
- Tap Analyze on a non-held watchlistable ticker → same flow; expect BUY block likely (LLM has nothing to sell), maybe SELL block if it thinks a short-equivalent exit case exists.
- Tap Analyze on a position with strong bull + bear signals → both SELL and BUY blocks render; pills row on TickerCard shows both.
- Tap Analyze again immediately → 429 with soft-block prompt → confirm → new analysis runs and supersedes the prior analysis's signal rows (`superseded_by_analysis_id` populated, latest renders).
- Force 51 analyses in a day (test mode) → 51st returns daily-limit-reached.
- Crash mid-analysis via SIGKILL on the api → cron cleans up stale lock within 5 min → button re-enables.
- Send a malformed LLM response (test mode) → retry happens → second failure writes `no_signal` row with reason "LLM response malformed" → no crash.

---

## Batch 14b: Daily hindsight accuracy tracking cron

**DEFERRED (2026-05-26):** signal quality is currently poor, so measuring accuracy is premature. The single-direction rework is now happening as **Batch 14g** (single-direction playbook engine + computed feature pack) → **14h** (live per-leg tracking + Refine). 14h's live tracking is the per-leg accuracy foundation; revisit/un-defer this hindsight cron once 14g/14h land and base quality is confirmed. Full design in `spec/signals/playbook.md`; scope in `CLAIMS.md`.

**Depends on:** Batch 14a, 13.7.

**Scope:** Once daily, after market close, update accuracy fields on all open signals using Finnhub intraday candles. Empirical foundation for "is the LLM actually good." IB-independent — works whether or not the user has IB connected.

### Deliverables

1. **`server/src/cron/accuracyUpdater.ts`** — runs daily at ~4:30 PM ET (after regular session close):
   - For each signal where `superseded_by_analysis_id IS NULL` AND `analyzed_at` within last 30 days:
     - Fetch intraday candles (5-min or hourly bars) from Finnhub for today's date for this symbol, through the queue with `category: 'candle'`.
     - Compute today's high, low, and the time the high/low were reached.
     - Update `actual_max_since_analysis = max(prior, today_high)`, `actual_min_since_analysis = min(prior, today_low)`.
     - If price entered `[price_range_low, price_range_high]` for the first time: set `entered_range_at` to the candle timestamp.
     - If price was in range and exited: set `exited_range_at`.

2. **Schema migration `supabase/migrations/00X_acted_on_at.sql`**:
   - Add `acted_on_at timestamptz null` to `signals`. Set by FE when user taps "I acted on this" in the Alerts feed (UI lands in Batch 15). Used downstream by post-MVP signal post-mortem feature.

3. **`server/src/routes/signals.ts:GET /api/signals/accuracy`**:
   - Returns rolling stats: hit-rate (% of sell signals where actual_max ≥ optimal_price within the predicted timeframe), median-distance-from-target, time-to-hit, signals-expired-without-hit.
   - Aggregates over last 30 days, last 90 days, all-time.
   - Used by Batch 15's Alerts feed.

### Files this batch creates/edits
- `server/src/cron/accuracyUpdater.ts` (new), `server/src/routes/signals.ts` (add `/accuracy`), `supabase/migrations/00X_acted_on_at.sql`.

### Does NOT touch
- pricePoller, zone detection, FE Signal Section.

### Verification
- Run cron manually → confirm `actual_max_since_analysis` updates for all open signals.
- `GET /api/signals/accuracy` returns sensible JSON (empty stats are fine for early days).

---

## Batch 14c: Profit-taking zone detection + Discord notifications + card UI

**Depends on:** Batch 13.8.

**Scope:** Continuous detection that a position is in profit-taking zone (P&L crosses threshold). One Discord notification per zone-entry with 4h cooldown. Card UI emphasis with tooltip. LLM `contextualTriggers` field populated. Replaces the originally-planned pre-market gap detection — gap is now just one cause of zone-entry, marked with a small "GAP" badge for the day.

### Deliverables

#### Backend

1. **Schema (`supabase/migrations/00X_profit_zone.sql`)**:
   - Add to `positions`: `zone_entered_at timestamptz null`, `zone_exited_at timestamptz null`, `last_zone_notification_at timestamptz null`, `entered_zone_via_gap boolean not null default false`.
   - Add to `user_preferences`: `profit_zone_threshold_pct numeric not null default 2.0`.

2. **Zone state recomputation** — extend `ibPricePoller` and `finnhubPricePoller` (from Batch 13.8) to compute zone state on every write:
   - Read user's threshold from `user_preferences`.
   - `wasInZone = (priorRow.zone_entered_at !== null)`; `nowInZone = pnlPct >= threshold`.
   - If `!wasInZone && nowInZone`: set `zone_entered_at = now()`, `entered_zone_via_gap = (now() < todays_regular_open_in_ET)`, call `discord.notifyZoneEntry()` (which checks cooldown internally).
   - If `wasInZone && !nowInZone`: set `zone_exited_at = now()`, clear `zone_entered_at`.
   - At end-of-regular-session each day: clear `entered_zone_via_gap` for all positions (small daily cleanup task).

3. **`server/src/services/discord.ts`** — extend existing multi-channel notifier:
   - New env var: `DISCORD_WEBHOOK_ZONES`.
   - `notifyZoneEntry(position)` function. Internal cooldown check: if `last_zone_notification_at` is within 4h, skip silently. Else fire notification and set `last_zone_notification_at = now()`.
   - Message format: `🔔 {symbol} entered profit-taking zone — P&L +{X.XX}% (threshold: +{Y}%){gap suffix if viaGap}`.

4. **`contextualTriggers` populated in `signalEngine`** (cooperates with Batch 14a):
   - When user taps Analyze, signalEngine reads position's `zone_entered_at` and `entered_zone_via_gap`.
   - If `inZone`: populate `contextualTriggers.inProfitTakingZone = { thresholdPct, currentPnlPct, viaGap }`.
   - The LLM prompt's contextual-triggers section interpolates: "This position is in profit-taking zone (P&L +X.X%, threshold +Y%). Address specifically: should we take profit here, or hold for more? {If viaGap: 'Zone entry was caused by an overnight gap, which often fades at open due to others taking profit.'}"
   - This batch updates the prompt template; the framework hookup itself happened in 14a.

#### Frontend

5. **`client/src/components/PortfolioHome/PositionCard.tsx`**:
   - When `position.zone_entered_at IS NOT NULL` (and not exited): render small icon (initial pick: `⇡` Unicode glyph or a lightning-bolt SVG — final choice during implementation) next to the P&L number on the card.
   - **Tooltip**: hover (desktop) or long-press (mobile) shows: `"Profit-taking zone — P&L crossed +{threshold}% threshold. Consider analyzing."`. Use a small `Tooltip` common component (Radix UI tooltip is fine; or hand-rolled with proper a11y attributes).
   - When `entered_zone_via_gap`: additionally render a small "GAP" mini-badge near the icon for the trading day.
   - Card structural layout is NOT altered. Icon and GAP badge are inline with P&L.

6. **`client/src/components/TickerDetail/SignalSection.tsx`** — when position `inZone`, show inline shortcut button "Analyze for profit-taking?" that triggers the normal Analyze flow (the `contextualTriggers` get auto-attached server-side based on current zone state).

7. **Common `Tooltip` component** (`client/src/components/common/Tooltip.tsx`) — if it doesn't already exist. Hover for desktop, long-press for mobile. ESC dismisses. Used by the zone icon and gap badge here; potentially other future hover-help surfaces.

### Files this batch creates/edits
- `supabase/migrations/00X_profit_zone.sql`, `server/src/cron/ibPricePoller.ts` + `finnhubPricePoller.ts` (zone recompute), `server/src/services/discord.ts` (zones channel + notifyZoneEntry), `server/src/services/signalEngine.ts` (contextualTriggers populator), `client/src/components/PortfolioHome/PositionCard.tsx`, `client/src/components/TickerDetail/SignalSection.tsx`, `client/src/components/common/Tooltip.tsx`, `client/src/types/index.ts` (Position type additions: `zone_entered_at`, `entered_zone_via_gap`, etc.).

### Manual prerequisite (user)
- Create new Discord channel `#upside-zones`, generate webhook, add `DISCORD_WEBHOOK_ZONES` to VPS `.env`, `docker compose restart api`.

### Verification
- Set threshold to 0.5% temporarily; positions cross threshold → Discord ping arrives in `#upside-zones`, card icon appears.
- Tooltip on hover (desktop) and long-press (mobile) shows correct text.
- Price flips in/out of zone within 4h → only first transition notifies.
- Manually update a position to simulate overnight gap (write a zone-entry timestamp before today's open) → GAP badge renders alongside zone icon → clears at end of session.
- Tap Analyze on a zone position → signal reasoning explicitly addresses profit-taking decision.

---

## Batch 14d: Signal-range Discord notifications (SELL + BUY)

**DEFERRED (2026-05-26):** deferred alongside Batch 14b until signal quality improves (see the 14b note + `CLAIMS.md` → Known issues). The zone-entry notifications in 14c still ship; this is specifically the *signal-range* pings.

**Depends on:** Batch 14a, 14c.

**Scope:** Notify when live price enters an open signal's predicted range. Same Discord infrastructure as 14c, different trigger and channels. **Two channels from day one** — SELL and BUY — because Batch 14a's unified analysis produces both signal types in MVP.

### Deliverables

1. **`server/src/services/discord.ts`** — `notifySignalRangeEntry(signal, position)`. Routes by signal type:
   - `signalType: 'sell'` → `DISCORD_WEBHOOK_SIGNALS_SELL` channel.
   - `signalType: 'buy'` → `DISCORD_WEBHOOK_SIGNALS_BUY` channel.
   - SELL message: `🎯 {symbol} entered SELL range — price ${price} ∈ [${low}, ${high}], optimal ${optimal} · motivation: {motivation}. Generated {when}.`
   - BUY message: `🎯 {symbol} entered BUY range — price ${price} ∈ [${low}, ${high}], optimal ${optimal} · motivation: {motivation}. Generated {when}.`

2. **Trigger logic** — extend the same price pollers from 13.8:
   - For each price write, check all open signals (`superseded_by_analysis_id IS NULL` AND not expired) for this position. Loop over both SELL and BUY signals.
   - If `current_price` is within `[price_range_low, price_range_high]` and `entered_range_at IS NULL`: fire notification (to the correct channel based on signal type), set `entered_range_at`.
   - Cooldown not needed — signal-entry is a one-time event per signal row (subsequent re-entries are recorded via accuracy tracking, not re-notified).

3. **Future channels reserved**: `DISCORD_WEBHOOK_EVENTS` (post-MVP for info badges like earnings/insider/volume). Document in `.env.example`.

### Files this batch creates/edits
- `server/src/services/discord.ts`, `server/src/cron/ibPricePoller.ts` + `finnhubPricePoller.ts` (range-check hook), `.env.example`.

### Manual prerequisite (user)
- Create `#upside-signals-sell` Discord channel + webhook → `DISCORD_WEBHOOK_SIGNALS_SELL` to `.env`.
- Create `#upside-signals-buy` Discord channel + webhook → `DISCORD_WEBHOOK_SIGNALS_BUY` to `.env`.
- `docker compose restart api`.

### Verification
- Generate a unified analysis with a SELL range slightly above current price. Wait for price to drift up into range. Discord ping arrives once in `#upside-signals-sell`; `entered_range_at` set on the SELL signal row.
- Generate a unified analysis with a BUY range slightly below current price. Wait for price to drift down into range. Discord ping arrives once in `#upside-signals-buy`; `entered_range_at` set on the BUY signal row.
- Re-trigger same condition → no duplicate notification (one-time event).
- Same analysis producing both SELL and BUY: only the relevant channel fires when price enters its respective range.

---

## Batch 14e: Marketdata snapshot endpoint + TickerDetail wire-up

**Depends on:** Batch 13 (live IB), Batch 13.8 (Finnhub queue for fallback).

**Scope:** Fill the TickerDetail data that's been hardcoded empty since the screen was built against mock data. `useTickerDetail` currently returns `dayLow/dayHigh: 0`, `currentInRange: 0`, `marketStats: []` (see comments in `client/src/hooks/useTickerDetail.ts`), so **Today's Range** shows zeros and **Market Stats** is blank. This batch builds the snapshot endpoint that feeds both. Spec: `screens/_design-system.md` → Today's Range / Market Stats (data-source notes).

### Deliverables
1. **`GET /api/marketdata/snapshot/:symbol`** (`server/src/routes/marketdata.ts`) — auth-gated. Returns `{ dayLow, dayHigh, open, prevClose, last, week52High, week52Low, stats: { volume, peRatio, eps, marketCap, beta, avgVol30d, ... } }`.
   - Primary source: IB snapshot (subscribe-wait-fetch `ibSnapshot`, already built) for day range + intraday fields; IB fundamentals for 52-week range / P-E / EPS / beta / market cap.
   - Fallback: Finnhub quote + basic-financials via the rate-limited queue when IB is disconnected.
2. **`useTickerDetail` wire-up**: replace the hardcoded `0`/`[]` with the snapshot fields; compute `currentInRange` from real `dayLow/dayHigh`. Map the stat pool to the `MarketStats` panel; keep `stat_config` ordering.
3. **Caching**: short Redis TTL (e.g. 30-60s) on the snapshot per symbol to avoid hammering IB on every TickerDetail open.

### Files
- `server/src/routes/marketdata.ts`, `server/src/services/ibGateway.ts` (snapshot/fundamentals field mapping), `server/src/services/finnhub.ts` (fallback), `server/src/services/redis.ts` (cache helper), `client/src/hooks/useTickerDetail.ts`, `client/src/components/TickerDetail/MarketStats.tsx`.

### Does NOT touch
- Signal engine, chart history endpoint (already real), pollers.

### Verification
- Open a held ticker → Today's Range bar reflects real day low/high with the dot positioned correctly; Market Stats grid populated; 52-week range bar shows real bounds.
- Disconnect IB → snapshot still returns via Finnhub fallback (some fundamental fields may be null — render "—").

---

## Batch 14f: TickerDetail real-data chart + signal polish

**Depends on:** Batch 14a (signals/pills). Independent of 14e.

**Scope:** Four FE fixes where the chart/signal UI was built against mock data and doesn't behave on real data. Frontend-only (Vercel deploy). Spec: `screens/_design-system.md` → Price Chart / Signal Section.

### Deliverables
1. **RSI subchart** — `PriceChart.tsx` hardcodes `rsi: []` on the real-data path (line ~40), so the RSI line never draws while the decorative band `<div>`s still render ("bands but no data"). Compute RSI **client-side** from the fetched candles and render the line; render the bands only when RSI data is present.
2. **Y-axis scaling** — the main price scale uses default autoscale margins (~20% top), pushing the top far above the day's high (e.g. 4.8 shown for a 4.59 high). Set explicit `rightPriceScale.scaleMargins` (tighter top) so the high sits closer to the top edge.
3. **Entry / position-price line** — already wired to `positionStats.avgCost` but too faint, and the "Entry" arrow marker lands at the chart's left edge when no real entry date is in-window. Make the horizontal avg-cost line prominent + labeled ("Avg $XX.XX"); render the entry-date marker only when the purchase date falls in the visible window.
4. **Collapsed Signal section shows pills** — extend `CollapsibleSection` with an optional header accessory; in the Signal section render the `SignalPill` row there so the actionable signals stay visible when collapsed (parity with TickerCard).

### Files
- `client/src/components/TickerDetail/PriceChart.tsx`, `client/src/components/common/CollapsibleSection.tsx`, `client/src/components/TickerDetail/TickerDetail.tsx`, `client/src/components/TickerDetail/SignalSection.tsx`, `client/src/styles/components.css`. RSI: reuse `technicalindicators` or a small local RSI util.

### Does NOT touch
- Backend, marketdata snapshot (that's 14e), signal engine.

### Verification
- Toggle RSI on a real ticker → line renders inside the banded pane; bands gone when RSI unavailable.
- Chart top sits just above the day's high, not ~5% over.
- Avg-cost line is clearly visible + labeled; no stray "Entry" marker at the chart edge.
- Collapse the Signal section → the SELL/BUY pills remain visible in the header.

---

## Batch 14.5: Schema cleanup — remove `position_history`

**Depends on:** Batch 13.

**Scope:** Drop the unused `position_history` table and related references. MTD now comes from Redis cached month-start (Batch 13.5); accuracy lives on `signals`. The table was deferred-feature scaffolding that never had a real use case.

### Deliverables
1. **`supabase/migrations/00X_drop_position_history.sql`**: `drop table if exists position_history cascade;`.
2. Edit `supabase/migrations/001_initial.sql` (the consolidated baseline) to remove the `position_history` table definition so a future fresh apply doesn't recreate it.
3. Grep codebase for any imports / types referring to it → remove.
4. Spec entry for `position_history` already removed (handled in spec edits).

### Files this batch creates/edits
- `supabase/migrations/00X_drop_position_history.sql`, `supabase/migrations/001_initial.sql`, possibly `server/src/types/index.ts`.

### Does NOT touch
- Active features.

### Verification
- `select * from position_history` errors with "relation does not exist".
- `pnpm typecheck` clean (or equivalent).

---

## Batch 13.9: Finnhub call inventory + per-category cadence tuning

**Depends on:** Batches 14a, 14b, 14c, 14d (all Finnhub callers must exist before tuning).

**Scope:** Now that all Finnhub callers in the codebase are real, inventory them and set sensible per-category min-intervals on the queue.

### Deliverables

1. **Inventory document** — short markdown table inside this batch's commit listing every Finnhub call:
   - Caller (`signalEngine`, `accuracyUpdater`, `finnhubPricePoller`, etc.)
   - Category (`quote`, `candle`, `news`, ...)
   - Trigger (user-action, cron, fallback-only)
   - Acceptable staleness ("price needs <90s fresh"; "news every 15 min is fine")

2. **Update default config in `finnhubQueue.ts`** with per-category min-intervals. Approximate starting values (tune empirically):
   - `quote`: 60s per-key (fallback-only — when IB is on, this never fires)
   - `candle`: 4h per-key (accuracy cron runs once daily)
   - `news`: 15min per-key
   - `insider`: 12h per-key
   - `earnings`: 24h per-key
   - `profile`: 7d per-key

3. **Verify under load** — fire a synthetic burst of analyses + price polls; confirm no 429s and that all caller-side flows still complete (any waits should be acceptable given the categories).

### Files this batch creates/edits
- `server/src/services/finnhubQueue.ts` (config map), commit message contains the inventory table.

### Does NOT touch
- Anything else.

### Verification
- Burst test passes without 429s.
- Real-world usage over a day shows no Finnhub error rows in `external_api_metrics`.

---

## Batch 15: Alerts feed + Settings wired

**Depends on:** Batch 14a, 14b, 14c.

**Scope:** Replace the two `ComingSoon` placeholders with real screens. Reflects the unified-analysis decision (Alerts now lists both SELL and BUY signal events) and the 2-tab MVP bottom nav (Alerts is a bell icon in the Portfolio screen header, not a bottom-nav destination — see spec).

### Deliverables

1. **Alerts surface — bell icon in Portfolio header → Alerts screen**. The bell renders a small unread-count badge when there are new signal/zone events since the user last viewed the screen.

2. **Alerts feed** — chronological list of all signal-related events, newest first:
   - SELL signal generated, SELL range entered (Discord-fired)
   - BUY signal generated, BUY range entered (Discord-fired)
   - Zone entered (Discord-fired)
   - no_signal analyses (so user sees "I looked at NVDA, no signal" history)
   - **Display filter slider**: "Show signals above ___% Quality" (range: 0-100, default 50). **Display filter only — does NOT affect generation.** Settings has the separate generation threshold.
   - Filter pills: All / Sell / Buy / Zone-Entry / no_signal.
   - Empty state: "No signals yet. Tap Analyze on any position to generate one."

3. **"I acted on this" button** on each Alerts list item → POST sets `signals.acted_on_at`. Zone-entries get a similar lightweight "Mark as seen" affordance.

4. **Aggregate accuracy display** at top of Alerts feed: pulls from `GET /api/signals/accuracy` from Batch 14b. Shows per signal type:
   - "Recent SELL signals: X% hit-rate over 30d, median +Y% from optimal."
   - "Recent BUY signals: X% hit-rate over 30d, median +Y% from optimal."
   - Placeholder copy if data is sparse in early days.

5. **Settings (`/settings`)** — app-level (per spec):
   - **IB Connection**: status indicator + Connect/Disconnect button.
   - **Signal generation threshold** (signal-quality minimum to bother generating; persists to `user_preferences.signal_threshold`). Clarify in copy: "BE-level minimum; the Alerts feed has a separate display filter."
   - **Signal min market value** ($, persists to `user_preferences.signal_min_market_value`).
   - **Suppressed symbols** (text list, persists to `user_preferences.suppressed_symbols`).
   - **Profit-taking zone threshold** (slider 0.5%-10%, default 2%, persists to `user_preferences.profit_zone_threshold_pct`).
   - **Theme** (Dark / Light / System, persists).
   - **Analysis engine** — provider + model picker. **Pre-built in Batch 14a** (Settings "Analysis engine" section): lists only providers with a key configured, persists to `app_config` via `POST /api/config/llm`, Realtime-synced, takes effect on next analyze. Batch 15 just folds it into the final Settings layout — no rebuild.
   - **Sign out** button.

6. **`PUT /api/user/preferences`** — BE endpoint validates + upserts the user_preferences row. FE writes through this rather than directly to Supabase to keep validation centralized.

### Files this batch creates/edits
- `client/src/pages/Alerts.tsx`, `client/src/pages/Settings.tsx`, `client/src/components/AlertsFeed/*`, `client/src/components/Settings/*`, `client/src/hooks/useUserPreferences.ts`, `client/src/routes.tsx`, `server/src/routes/user.ts` (new — preferences PUT/GET).

### Verification
- Tap bell icon → Alerts list renders, shows signals + zone-entries.
- Tap settings cog → Settings screen renders. Change theme → applied immediately. Change LLM provider → next Analyze uses new provider.
- Adjust profit-zone threshold to 3% → next zone-cross uses new threshold.
- Suppressed symbol: add BBAI to suppression → Analyze button no longer appears on BBAI's TickerDetail.

---

## Batch 16: Polish + PWA push notifications

**Depends on:** Batch 15.

**Scope:** Final pre-MVP sweep. Loading/error/empty states, mobile install guidance, a11y pass, and PWA push notifications (replacing the originally-dropped MVP item).

### Deliverables

1. **Loading states** for every async surface (initial portfolio load, chart load, analyze in progress, settings save).
2. **Error states**: BE unreachable, IB session stalled mid-action, Supabase Realtime disconnect with reconnect.
3. **Empty states** with helpful guidance (no positions: "Connect IB"; no signals yet: same as Batch 15).
4. **Mobile install guidance**: a one-time tip on the Vercel landing screen explaining "Add to Home Screen" on iOS Safari.
5. **Accessibility pass**: keyboard focus order, screen-reader labels on icon buttons, color contrast ratios checked, motion-reduce honored. Tooltip semantics on the zone icon verified.
6. **PWA push notifications**:
   - Service worker push subscription on first launch (with permission prompt).
   - VAPID key generation + backend dispatch logic via the `web-push` npm library.
   - Subscribed devices get notified on the same triggers Discord uses (zone-entry, signal-range-entry). Discord stays as the developer/admin channel; PWA push is the user-facing channel.
   - Quiet hours support in Settings (defer if scope creeps — Discord-only is acceptable for MVP).
7. **Optional smoke tests** if `client/` test infra exists (vitest scaffold from earlier deferred batch).

### Files this batch creates/edits
- Scattered touches across `client/src/`, plus `server/src/services/webPush.ts` (new), `client/public/service-worker.js`.

### Verification
- Manual walkthrough: kill the BE, see graceful error UI on phone. Restart BE, see reconnect.
- Lighthouse audit on the Vercel URL: PWA install criteria met, accessibility score ≥ 90.
- PWA push: grant permission on phone, kill the app, trigger a zone-cross from another device or by manual Supabase update → phone notification arrives within seconds.

**🎯 Milestone: MVP per spec.**
