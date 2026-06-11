# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

_(none)_

## Known issues (deferred fixes)

- **TickerDetail loading/error states say "coming soon"** — `TickerDetailPage` reuses the `ComingSoon` placeholder for loading/error/not-held, so opening a position briefly shows "Loading SYMBOL… · SYMBOL — coming soon". Needs real skeleton/error/empty states. Folds into Batch 16 (loading/error/empty sweep). Spec: `screens/_design-system.md` → Screen 2 note.
- **TickerDetail Indicators section empty** — `useTickerDetail` hardcodes `indicators: []`; the data exists on `analyses.indicator_snapshot` but isn't surfaced. Wants a future batch to render the latest analysis's indicators (incl. a pre-Analyze empty state). Spec: `screens/_design-system.md` → Indicators note.

## Completed

### Batch ARCH-6 — Ports & adapters (Phase 2): discord adapter (2026-06-11)
- Owner: claude
- Started: 2026-06-11 15:03
- Finished: 2026-06-11 17:55
- Commit: f31b8fe

**What shipped.** `notify.ts` inverted onto a new `adapters/discord/` — the third Phase-2
vendor slice. `port.ts` defines the `Notifier` interface (`post(channel, payload)` +
`has(channel)`) over nine logical `DiscordChannel` names; `discordAdapter.ts` is now the SOLE
importer of the nine `env.discord*WebhookUrl` fields and owns channel→URL resolution (incl.
the critical→routine fallback), the 5s-timeout `axios.post`, the never-throw swallow, and the
no-op-when-unconfigured behavior. Discord is a multi-full-URL delivery sink (one webhook URL
per channel), not a single-base REST API, so the adapter does **not** extend `HttpAdapter` —
its delivery is an injectable constructor seam (`new DiscordAdapter(fakeDeliver)`) instead.
`notify.ts` keeps all *policy*: the per-key cooldown state, severity→color, and all 14 alert
formatters; it now calls `discord.post(channel, ...)` instead of reading webhook URLs +
posting. `has()` preserves the exact early-bail-before-cooldown semantics of the old
`webhookFor()`/`!url` guard, so no cooldown state is touched when a channel is unconfigured.

No external caller changed — every consumer still imports the same public `notify*` functions
(none ever touched the internals or `env.discord*`).

- **Live-flip prereqs:** none. Pure relocation; same channels, payloads, fallback, no-op
  semantics. `git pull && ./bin/upside rebuild api` is behaviorally identical.
- **Verification:** typecheck clean; **208/208** vitest green (+4 new `discordAdapter.test.ts`
  cases: channel delivery, critical fallback, unconfigured no-op, `has()`); grep gate clean
  (`env.discord*` only under `adapters/discord/`).
- **Commits:** `f31b8fe` (adapter + notify.ts) · `docs(arch):` ARCH-6 progress note.
- **Follow-ups deferred:** none for discord. Next Phase-2 slice = `finnhub` (`finnhub.ts` +
  `finnhubQueue.ts` → `FinnhubPort`; the slice that makes `HttpAdapter` absorb the
  hand-rolled metric/notify/retry instrumentation), then `ib` (multi-slice sub-batch, last).

### Batch ARCH-5 — Ports & adapters (Phase 2): polygon + yahoo reference slice (2026-06-11)
- Owner: claude
- Started: 2026-06-11 08:56 · Finished: 2026-06-11 09:24
- Commits: `e738b52` ports reference (HttpAdapter + polygon/yahoo) · `4077f79` db/ → adapters/supabase/ relocation · `232a09b` arch doc
- **Why:** first Phase-2 slice off `docs/arch/target-architecture.md` → Phase 2. Establishes the **ports & adapters** pattern — one adapter is the SOLE path of access to a vendor; callers depend on a **vendor-shaped Port** interface, never the SDK — the HTTP analog of TableModule. Polygon is the reference because it wasn't a chokepoint (it cohabited Yahoo inside `services/universeQuote.ts` with raw `axios.get`), so the slice is genuine consolidation. **No behavior change.**
- **What shipped:**
  - **`adapters/HttpAdapter.ts` (new)** — shared base: one axios client bound to the vendor base URL + permissive `validateStatus` (the adapter inspects/maps/throws). The HTTP analog of `TableModule.ts`. Shipped **minimal** on purpose — it grows to absorb the metric/notify/retry `finnhub.ts` + `ibGateway.ts` hand-roll when those vendors migrate (next slices), the way `TableModule` gained `runCount` only when a slice needed it.
  - **`adapters/polygon/`** — `PolygonPort.groupedDaily` + the `polygon` singleton; sole path to `api.polygon.io`. **`adapters/yahoo/`** — `YahooPort.chart` + the `yahoo` singleton; sole path to `query1.finance.yahoo.com`. Both lifted out of `services/universeQuote.ts` (deleted), same endpoints/params/headers/mapping.
  - Shared **`DailyOhlcv`** moved to `types/index.ts` (spoken by both adapters + `dailyBars.ts`). `universeQuoteProducer` rewired to `polygon.groupedDaily` / `yahoo.chart` — it keeps its own `notifyError` policy (adapters don't notify). The 9 parser tests split into co-located `polygonAdapter.test.ts` (5) + `yahooAdapter.test.ts` (4), mocking `axios.create` to inject a fake client (the test seam).
  - **`db/ → adapters/supabase/` move** — folded in: all 25 TableModule files relocated to their final home under `adapters/` (git-tracked as 25 renames). Pure path change (one level deeper → moved files' `../` parent imports shift to `../../`; 83 external importers + one lazy `await import()` in `services/supabase.ts` rewritten). Closes the last Phase-1 housekeeping item.
- **Verification:** typecheck clean; **204/204** tests green (per commit). Grep gate: vendor base/key (`api.polygon.io` / `query1.finance.yahoo.com` / `env.polygonApiKey`) only under `adapters/`. No migration, no env/Discord/schema change.
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Behaviorally identical — the universe producer pulls Polygon + gap-fills Yahoo exactly as before.
- **Follow-ups (next Phase-2 slices):** `discord` (`notify.ts` → `Notifier` interface — already one chokepoint, near-free), then `finnhub` (the `finnhubQueue` rate-limit quirk becomes the adapter's; absorbs `instrumented()` into `HttpAdapter`), then `ib` as its own multi-slice sub-batch (the monster). `llm` deferred (roadmap Track 4).

### Batch ARCH-4 — remaining-tables TableModule rollout (Phase 1 fully done) (2026-06-11)
- Owner: claude
- Started: 2026-06-11 03:42 · Finished: 2026-06-11 05:15
- Commits: `405942b` app_config · `c096d35` access_attempts · `f51cd24` external_api_metrics · `7fa3a38` screener_jobs (reaper/retention → queue.ts) · `2d970e9` user_preferences · `9e25143` contracts · `d7917a6` signals · `04682fe` arch doc
- **Why:** finish the "every table behind a module" rule. ARCH-3 closed the 14-table rollout but explicitly carved out a handful of tables that were never in the rollout list and still had direct `from(...)` call-sites (`docs/arch/target-architecture.md` → "Out of the original ARCH-3 scope"). This sweep gatekeeps them too. **No behavior change** — same SQL/rows/conflict keys, relocated behind intention-revealing methods; the I/O + snake↔camel mapping move into each module, business/error policy stays in the callers.
- **What shipped (one commit per table):**
  - **`app_config`** → `appConfigTableModule` (`getValue`/`setValue`); the `appConfig.ts` kv service + `tunnelWatcher` route through it, each keeping its own notify-on-fail/return-null leniency around the now-throwing module.
  - **`access_attempts`** → `accessAttemptsTableModule.record()`; the Google-auth audit append in `routes/auth.ts`, wrapped so a logging failure still never blocks the auth decision.
  - **`external_api_metrics`** → `externalApiMetricsTableModule` (`record()` + count-returning `purgeOlderThan()`); the IB gateway (`instrumented`/`instrumentedWithRetry`) + Finnhub (`recordMetric`) fire-and-forget writers + `metricsRetention`. `ibGateway.ts` + `finnhub.ts` dropped their `supabase` import.
  - **`screener_jobs` stragglers** → `reapExpiredClaims()` + `purgeTerminalOlderThan()` added to the `queue.ts` prototype module; `jobsReaper` + `jobsRetention` call them, so **all** screener_jobs access lives in `queue.ts`.
  - **`user_preferences`** → `userPreferencesTableModule` (`getByUserId`/`getAny`/`upsert`, camelCase `UserPreferences` + `UserPreferencesPatch`); the prefs-route writer (validation/bounds stay in the route) + the riskFlagsCron / profitZone / signalEngine readers. riskFlagsCron + profitZone dropped their `supabase` import.
  - **`contracts`** → `contractsTableModule` (`getByConid`/`upsert`), speaking the shared camelCase `Contract` (types/index.ts); ibPricePoller's staleness-refresh (its local `ContractsCacheRow` deleted, `assemblePosition` reads camelCase) + signalEngine's lazy fill. **ibPricePoller no longer imports `supabase`.**
  - **`signals`** → `signalsTableModule` (`supersedePriorForSymbol` + the two-shape `insertSignal`, optional columns emitted only when supplied so a no_signal row omits them exactly as before); signalEngine's `persistAnalysis`. **signalEngine no longer imports `supabase` at all.**
- **Verification:** per slice — grep gate (no `from('<table>')` outside its module), server typecheck clean, **204/204** tests green. Final sweep: **zero** `from('<table>')` anywhere in `server/src` outside a `*TableModule.ts` / `queue.ts`. No migrations, no env/Discord/schema changes. Every slice pushed to `dev` immediately (Vercel auto-deploy).
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Behaviorally identical — every route/cron/producer writes and reads the same rows as before.
- **Net state:** 24 tables behind TableModules (+ the base `TableModule.ts`) + the `queue.ts` prototype for `screener_jobs` = **every Supabase table is gatekept.** Phase 1 of `docs/arch/target-architecture.md` is fully complete.
- **Follow-ups:** the mechanical `db/ → adapters/supabase/` folder move (trivial later relocation, deferred), then **Phase 2 (ports & adapters)** — wrap each vendor (IB/Finnhub/Polygon/Discord/…) behind a port; **Phase 3** the `schedule()` primitive; **Phase 4** relocate the pure core into `domain/`.

### Batch ARCH-3 — remaining TableModules rollout (curated_list → analyses) (2026-06-10)
- Owner: claude
- Started: 2026-06-10 09:30 · Finished: 2026-06-10 19:05
- Commits: curated_list/entry_zones/band_state/intraday_stats/daily_bars (single-writer half) · `6625e5c` universe · `4550e8c` quotes · `348f6aa` positions · `081312b` signal_fires+signal_outcomes · `29d215a` risk_flags · `c2bb4ec` watchlist_lists+items+markers · `af608a4` analyses+analysis_locks
- **Why:** finish Phase 1 of `docs/arch/target-architecture.md` — every table in the rollout order behind its own TableModule (one writer-owner; the only place that table is read/written), continuing the ARCH-1 (`news_sentiment`) + ARCH-2 (`trait_scores`) reference pattern. **No behavior change** — same SQL/rows/conflict keys, relocated behind intention-revealing methods; business policy stays in the services/crons, only I/O + snake↔camel mapping moved.
- **What shipped (the 14-table rollout, one commit per table/slice):**
  - **Single-writer half** — `curated_list`, `entry_zones`, `band_state`, `intraday_stats`, `daily_bars`: each a lift behind a named-method module.
  - **Multi-writer half** (where the one-writer-owner rule does the work):
    - **`universe`** (6 writers / 10 files) — bulk sweep + stale retention + real_conid stamp + weekly cap + daily quote/volume + auto-promote + the `refresh_universe_avg_volume` RPC; readers take a uniform `UniverseRow`.
    - **`quotes`** (the price-SSOT hub) — `upsertLiveQuote` (IB/Finnhub/watchlist pollers funnel through), daily-seed bulk upsert, entry-zone sparkline; 6 read shapes. Price *policy* (canonical source, prev-canonical probe, freshness gates) stays in services.
    - **`positions`** (the holdings hub, 11 files) — IB poller full sync (`upsertHoldings` + `deleteOrphans` + `deleteAllForUser`), Finnhub `markFinnhubPriced`, `clearGapBadges`, + 8 read slices; the module owns the X5 write-column projection.
    - **`signal_fires` + `signal_outcomes`** (forward-tracking pair) — `insertFire`/`getRecentByKinds`/`getRecentSince` + `getExistingOffsets`/`upsertOutcomes`; dedup-to-newest + due math stay in the crons.
    - **`risk_flags`** — `getPrevRow`/`deleteRow`/`upsertRow` behind the one engine that already owned it.
    - **`watchlist_lists` + `watchlist_items` + `watchlist_markers`** (the trio) — sync insert/meta/active + items upsert/orphan-sweep + the marker CRUD/check; CRUD writes still return the raw snake_case row (FE wire contract).
    - **`analyses` + `analysis_locks`** — re-analyze soft-block + the sole persist insert; lock check/insert/finally-release/stale-sweep.
- **Verification:** per slice — grep gate (no `from('<table>')` outside its module), server typecheck clean, **204/204** tests green. No migrations, no env/Discord changes. Every slice pushed to `dev` immediately (Vercel auto-deploy).
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Behaviorally identical — every cron/route/producer writes and reads the same rows as before.
- **Out of ARCH-3 scope (noted in the arch doc as a follow-up):** tables never in the rollout list still have direct `from(...)` call-sites — `signals` (signalEngine supersede + insert), `contracts`, `user_preferences`, `app_config`, `external_api_metrics`, `access_attempts`, and the two `screener_jobs` crons (`jobsRetention`/`jobsReaper`) outside the `queue.ts` prototype. Folding these in would complete the "every table behind a module" rule but is a separate batch. Then the eventual mechanical `db/ → adapters/supabase/` folder move (Phase 1 → final layout).

### Batch ARCH-2 — trait_scores TableModule (3-writer showcase) (2026-06-10)
- Owner: claude
- Started: 2026-06-10 08:32 · Finished: 2026-06-10 08:39
- Commit: 73a666f
- **Why:** the second ARCH Phase-1 slice (`docs/arch/target-architecture.md` → Phase 1, "do second"). Where ARCH-1 (`news_sentiment`) proved the TableModule shape on a 1-writer table, `trait_scores` proves the **one-writer-OWNER** rule under **3 producers** writing the same table — the case the pattern exists for. **No behavior change** — same SQL/rows/conflict key, relocated behind intention-revealing methods.
- **What shipped:**
  - **`server/src/db/traitScoresTableModule.ts` (new)** — sole gatekeeper + singleton. Writers: `upsertScores(scores[])` (chunked batch upsert on `conid,trait,asof_date`, stamps `computed_at`) and `stampFirstFire(conid, trait, asofDate)` (the atomic `last_fired_at` latch — returns true only on the first stamp so the caller pings once). Retention: `purgeOlderThan(trait, cutoff)` → deleted count. Readers: `getScoresByTrait` (curated seeds), `latestAsof(trait?|traits[])`, `getConidsByTraits`. Exports the `TraitScore` domain type + `TraitKind` union (`intraday_range_trader | catalyst_reversal | post_earnings_drift`).
  - **`server/src/db/TableModule.ts`** — added the `runCount(op, query)` base mechanic (affected-row count for `count:'exact'` deletes/updates, same `<table>.<op>` error wrap) consumed by per-trait retention. `PgResult` gained an optional `count`.
  - **Rewired all call-sites** to the module: the 3 producers — `intradayRangeTraderProducer` (batch upsert), `catalystReversalProducer` + `postEarningsDriftProducer` (single upsert + first-fire stamp; the catalyst `universe.auto_promoted` write stays inline — universe gets its own module later) — plus `traitScoresRetention` (per-trait purge; **dropped its `supabase` import**), `curatedListCron` (`loadSeeds` + `loadEventTraitConids` readers), and `curatedList/asof.ts` (the `trait_scores` branch → module; `curated_list` branch stays a direct read until ARCH-3). The `TraitKind` union also tightened `latestTraitAsof` + `SHELF_LIFE_DAYS`.
- **Verification:** grep gate — no `from('trait_scores')` anywhere in `server/src` outside the module. Server typecheck clean; **204/204** tests pass. Pure relocation, no new tests, no migration, no env/Discord change.
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Behaviorally identical — all three producers write `trait_scores` and `curatedListCron` reads it exactly as before; nothing user-visible changes.
- **Follow-ups:** ARCH-3 = next table on the rollout list (`curated_list` — already half-touched here: `asof.ts`/`curatedListCron` read it directly), then `entry_zones → band_state → intraday_stats → daily_bars → universe → quotes → …` per the design doc. Eventual mechanical folder move `db/ → adapters/supabase/`.

### Batch ARCH-1 — TableModule persistence layer (reference slice) (2026-06-10)
- Owner: claude
- Started: 2026-06-10 06:05 · Finished: 2026-06-10 07:56
- Commit: de53296
- **Why:** first implementation batch off the ARCH review (`docs/arch/target-architecture.md` → Phase 1). Establishes the per-table persistence pattern — a **TableModule** is the single gatekeeper for one Supabase table (the only place that table is read/written, one writer-owner) — using `news_sentiment` (1 writer + 1 reader) as the reference template every other table will follow. **No behavior change** — same SQL/rows, relocated behind intention-revealing methods.
- **What shipped:**
  - **`server/src/db/TableModule.ts` (new)** — thin abstract base, owns only *mechanics*: client/table binding (`from()`), consistent `<table>.<op>` error-wrapping (`run()`), and the `deleteOlderThan(col, cutoff)` retention primitive. ~40 lines, zero business logic — meaning (row mapping + intention-revealing methods) lives in each subclass.
  - **`server/src/db/newsSentimentTableModule.ts` (new)** — the reference module + singleton: `save()` (upsert, sole writer), `getByConids(conids, asofDate)` (risk-flags reader), `purgeOlderThan(cutoff)` (binds `asof_date`), plus the `NewsSentiment` domain type and snake↔camel `fromRow` mapping.
  - **`newsSentimentCron`** (writer + retention) and **`riskFlagsCron`** (reader) rewired to the module; their direct `from('news_sentiment')` calls deleted. `supabase`/`num` imports stay — both still used for other tables.
- **Verification:** grep gate — no `from('news_sentiment')` anywhere in `server/src` outside the module (it's the sole gatekeeper). Server typecheck clean; **204/204** tests pass. Pure relocation, no new tests, no migration, no env/Discord change.
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Behaviorally identical — `news_sentiment` rows produced by `newsSentimentCron` and read by `riskFlagsCron` exactly as before; nothing user-visible changes.
- **Follow-ups:** ARCH-2 (the `trait_scores` 3-writer showcase — proves the pattern under multiple writer-owners); roll the rest of the tables onto TableModules per the rollout list in the design doc; the eventual mechanical folder move to `adapters/supabase/`.

### Batch X10.2 — Catalyst same-session pipeline (fast advance loop) (2026-06-10)
- Owner: claude
- Started: 2026-06-09 17:38 · Finished: 2026-06-10 05:19
- Commit: d8ebff1 (code) · 79333c8 (spec)
- **Why:** even with X10 (RTH gate) + X10.1 (snapshot fix), catalyst couldn't reach the lists same-day. The producer ran one combined **24h** tick (enqueue + drain), and each tick's drain only saw *prior* ticks' `done` rows (workers run async after the tick), so Stage-1→Stage-2→`trait_scores` spanned 2-3 daily ticks ≈ **1-2 days** — useless for an intraday signal.
- **What shipped (`catalystReversalProducer.ts`):** split the single `tick()` into two loops.
  - **`produceTick`** (24h, first run **boot+2min**, was 10min): Stage-0 candidates + `enqueueStage1`. Enqueue dedups on the active job_key so an in-flight name is a no-op. First-delay shortened because the candidate deps (`universe.last_avg_volume`, `real_conid`) persist in the DB.
  - **`advanceTick`** (~2min): `drainStage1` (→ enqueue Stage-2 for qualifiers) + `drainStage2` (→ `trait_scores`) + the failure retries. **DB-only — no IB calls** (those stay in the gated worker handlers, enqueued once/name/day), so the tight cadence is cheap. Quiet log unless a stage moved.
  - Net: a conid flows Stage-1→Stage-2→`trait_scores` within minutes of the workers finishing each stage, same session.
- **Spec:** `job-queue.md` → Dependencies between actions — stage latency = drain-cycle length, not enqueue cadence; intraday pipelines split slow-produce / fast-advance (catalyst is the reference).
- **Verification:** server typecheck clean; 204/204 tests (loop restructuring — verified live, not unit-tested). No migration.
- **Live-flip:** `git pull && ./bin/upside rebuild api`. Then during RTH with IB up: produce fires ~boot+2min → Stage-1 runs (X10.1 → non-null `vol_multiple`, some `qualified:true`) → advance loop (~2min) enqueues Stage-2 → `trait_scores(catalyst_reversal)` rows within ~5-10 min; Intraday/Swing lists show catalyst chips. **This is the deploy that should finally show catalyst data same-session.**

### Batch X10.1 — Catalyst snapshot completeness (volume parse + field warmup) (2026-06-09)
- Owner: claude
- Started: 2026-06-09 16:44 · Finished: 2026-06-09 16:56
- Commit: e3212f7 (code) · 5e1da4e (spec)
- **Why:** X10 gated catalyst to RTH but `trait_scores(catalyst_reversal)` stayed **0 rows**. Live diagnosis (2026-06-09, mid-RTH, IB up) found two upstream snapshot bugs in `screener_jobs`: the 18 Stage-1 `done` rows were all `qualified:false`/`vol_multiple:null`, and 63 `failed` "missing price/open" *during* RTH.
- **What shipped:**
  - **`server/src/utils/ibNumber.ts` (new)** — `parseIbNumber` handles IB display-formatting: K/M/B/T magnitude suffixes (volume field 87 arrives as e.g. `"65595.7B"`), thousands commas, trailing %, native numbers; unparseable/prefixed (`"C12.34"`)/nullish → `NaN`. +4 unit tests. Root-causes bug #1 — the old `num()` stripped only `,`/`%` so `Number("65595.7B")=NaN` → null vol-multiple → nothing ever qualified.
  - **`ibGateway.ts`** — `ibSnapshot(conids, requiredFields?)` + `isSnapshotPopulated(row, required?)`: when required fields are named, the warmup poll waits until every one is present (not just *any* field). Fixes bug #2 — IB streams fields incrementally, so the old "any field present" check returned half-populated rows missing `31`/`7295`.
  - **`catalystReversalProducer.ts`** — Stage-1 uses `parseIbNumber` for all snapshot fields and calls `ibSnapshot([conid], ['31','7295','87','7296'])`.
  - **Spec** — `signals/screener-universe.md` → catalyst_reversal: recorded the formatted-volume + required-field-warmup gotchas.
- **Verification:** server typecheck clean; 204/204 tests (`ibNumber.test.ts` +4). Pure-logic; no live IB needed for tests. No migration.
- **Live-flip note:** `git pull && ./bin/upside rebuild api` on the VPS. Then during RTH with IB up: Stage-1 `done` rows should show non-null `vol_multiple`; qualified names enqueue Stage-2; `trait_scores(catalyst_reversal)` gains rows; Intraday/Swing lists show catalyst names. (Catalyst producer runs at boot+10min, 24h cadence — one Stage-1→Stage-2 producer-tick of latency between stages.)

### Batch X11 — FE data cache (stale-while-revalidate) (2026-06-09)
- Owner: claude
- Started: 2026-06-09 15:23 · Finished: 2026-06-09 15:28
- Commit: 3e158be
- **What shipped:** a tiny module-level stale-while-revalidate cache that kills the loading flash when a route / sub-tab switch unmounts (or re-`kind`s) one of the main data hooks.
  - **`client/src/hooks/dataCache.ts` (new)** — `readCache`/`writeCache` over a module `Map` keyed by `(hook, key)`. No new dependency (react-query/SWR deferred). Module-level → survives unmount, resets on full reload; not user-scoped (single-user app).
  - **Pattern (uniform across the three hooks):** seed state from the cache on mount (no `loading` state on a cache hit), revalidate via the existing Realtime sub + a background reload, write the snapshot back on every successful load so a remount is warm.
  - **`usePositions`** — caches `Position[]` under `'positions'`.
  - **`useWatchlistData`** — consolidated its 6 `useState` into one `WatchlistSnapshot`; caches under `'watchlist'`.
  - **`useVirtualList`** — caches `{ rows, asof, stale }` under `'virtual:<kind>'`; **re-seeds on `kind` change** because the `<VirtualList>` element stays mounted across Intraday↔Swing (a warm switch paints instantly; a cold one shows loading, gated in `VirtualList`, rather than the other kind's rows).
- **Verification:** client typecheck + build clean. FE-only — no schema/Realtime/engine change, no migration.
- **User-drives-UI verification (pending):** switch imported-watchlist ↔ Intraday/Swing repeatedly → no loading flash after the first load; rows still tick live via Realtime; a hard reload still shows the loading state once (cold cache).

### Batch X10 — Per-action job gates (gate-and-defer) + catalyst fix (2026-06-09)
- Owner: claude
- Started: 2026-06-09 07:47 · Finished: 2026-06-09 15:22
- Commit: a5c8664
- **What shipped:** a per-action precondition ("gate") layer on the job-queue worker. An action registers a gate in `gateRegistry[action]`; the worker evaluates it **post-claim / pre-execute** and on not-ready **defers** the job (status→`queued`, `scheduled_for=retryAt`, **`attempts` NOT incremented**) instead of executing-and-failing — so an out-of-window job never reaches the producer's give-up policy.
  - **`services/jobs/gates.ts` (new)** — `Gate` / `GateResult` types, `gateRegistry`, and the `requiresRthOpen` / `requiresMarketOpen` factories (injectable `clock` for tests). A gate is mechanical (like the pool gate), not business logic.
  - **`utils/marketHours.nextRegularOpenEtIso`** — DST-correct "next 09:30 ET on a trading day" resolver (walks past weekends/holidays); the retryAt source for the gates.
  - **`services/jobs/queue.deferJob`** — the reschedule path; the row stays inside the active partial unique index (`claimed`→`queued` are both active) so there's no dedup conflict.
  - **`services/jobs/worker.ts`** — evaluates the gate between handler-lookup and execute; defers on not-ready (returns `busy` so it keeps draining), and a gate that *throws* logs + falls through to execute (degrades to pre-gate behaviour rather than blocking work).
  - **Catalyst fix** — `eval_catalyst_stage1`/`_stage2` declare `requiresRthOpen` (`catalystReversalProducer.ts`). Root cause of the 0-rows bug: Stage-1 reads IBKR field `7295` (today's open, only exists intraday) and Stage-2 reads `ibHistory` (503s off-hours), but the producer's boot+10min tick lands overnight → every snapshot failed. Now overnight claims defer to the next 09:30 ET and run once IB is up during RTH.
  - **Channel rename** — `DISCORD_WEBHOOK_CATALYST_ALERTS` → `DISCORD_WEBHOOK_EVENT_ALERTS` (it always carried both event traits); the old var is read as a fallback alias so an un-updated `.env` keeps working. `env.ts` / `notify.ts` / `.env.example`.
- **Verification:** server typecheck clean; 200/200 server tests pass (`gates.test.ts` +6 — ready during RTH, defers from pre-market/after-hours/weekend to the correct next-open instant). Pure-logic tests; no live DB needed.
- **No migration** — `screener_jobs` already has `scheduled_for`/`attempts`; defer is a plain UPDATE.
- **Live-flip note:** `git pull && ./bin/upside rebuild api` on the VPS. Optional: rename the Discord channel + `DISCORD_WEBHOOK_EVENT_ALERTS` env var (fallback keeps the old one working). Verify: a catalyst Stage-1 job claimed overnight shows `status=queued`, `scheduled_for`=next 09:30 ET, `attempts` unchanged (no "missing price/open" failure row); during RTH the lists gain catalyst names.
- **Follow-up (now Batch ARCH item 2):** audit whether the gate model should extend to the other crons/jobs that can run on stale/absent inputs.

### Batch 15 — Settings wired (app-shell) (2026-06-08)
- Owner: claude
- Started: 2026-06-08 11:05 · Finished: 2026-06-08 14:25
- Commit: 54670fb (code) · 8d300f8 (spec+queue rescope) · 3868993 (claim)
- **Scope reframed mid-batch (user, 2026-06-08):** anything tied to the LLM **Analyze flow** belongs in the roadmap's LLM-analysis track, not MVP. So the signal-generation knobs were **scraped out of Batch 15** into `spec/roadmap.md` → Track 4 item 9 (signal-generation quality threshold + its unbuilt engine enforcement, signal min market value control, suppressed-symbols editor + hiding the TickerDetail Analyze button). A `signal_threshold` engine gate I had started in `signalEngine.ts` was **reverted**. `settings.md` drops them from MVP scope to a roadmap pointer.
- **What shipped (app-shell Settings only):**
  - **`Settings.tsx`** — added **IB connection** (reuses `IbStatusIndicator` + `useMarketSession`; the indicator is the tappable connect/disconnect control), **Profit-taking zone** slider (0.5–10%, → `user_preferences.profit_zone_threshold_pct`), **Theme** picker (System/Light/Dark), and **Sign out**. Kept the already-shipped Analysis-engine + Risk-flags sections.
  - **`useUserPreferences.ts` (new)** — reads/writes the general prefs (today just `profitZoneThresholdPct`) via the prefs route; `save` returns `{ ok, error }` so a shared instance doesn't leak errors across sections.
  - **`services/theme.ts` (new)** + **`index.html`** — theme is per-device localStorage applied via `data-theme` (light/dark palettes already in `tokens.css`); index.html honors the saved choice pre-paint to avoid a flash; updates `<meta name=theme-color>`.
  - **`server/src/routes/user.ts`** — extended `GET`/`PUT /api/user/preferences` to also carry `profit_zone_threshold_pct` under a `preferences` object alongside the existing `risk_flag_config` (partial PUT = partial override; backward-compatible response shape).
  - **`components.css`** — slider styles.
- **Verification:** server+client typecheck clean; client build clean; 194/194 server tests pass. No migration (all `user_preferences` columns already exist).
- **User-drives-UI verification (pending):** tap settings cog → screen renders; theme change applies + survives reload; profit-zone save → next zone-cross uses it; IB connect/disconnect reflects; Sign out → login.
- **Follow-ups (now in roadmap Track 4 item 9):** wire `signal_threshold` enforcement (note: default 70 vs current ~50–65 signal quality would hide most signals — revisit default), build the min-market-value + suppressed-symbols Settings controls, and hide the Analyze button on TickerDetail for suppressed symbols.

### Batch X9 — Populate the virtual lists (build race + curated quotes) (2026-06-08)
- Owner: claude
- Started: 2026-06-08 05:16 · Finished: 2026-06-08 05:35
- Commit: 76e5b35 (code) · a34f909 (spec) · 76e5b35 incl. queue meta in earlier f8af32a (claim)
- **Diagnosed (live DB):** Intraday/Swing lists never populate. `curated_list` empty (0 rows ever); `quotes` only 41 (held+watchlist). Two seams: (a) **build race** — `curatedListCron` read `trait_scores(asof_date=today)` at boot+90s but `intradayRangeTraderProducer` writes today's rows at boot+6min → 0 seeds → never built (strict `asof_date=today` also blanked the FE off-hours); (b) **quotes gap** — the virtual lists *and* the dip-bounce scorer read `quotes`, but nothing wrote curated prices there (they lived in `universe.last_price` + `daily_bars`), so curated rows dropped on the join and the scorer couldn't score them → empty `signal_fires`.
- **What shipped:**
  - **`services/curatedList/asof.ts` (new)** — `latestTraitAsof` / `latestCuratedAsof` / `isStale` (STALENESS_CAP_DAYS=4). The single "latest available date" resolver; membership is slow-moving character data so latest-available is safe (money-safety is the firing gate, not membership).
  - **`curatedListCron`** — seeds from the **latest** `intraday_range_trader` date (not `utcDate()`), persists curated_list under it, then calls `seedDailyQuotes(curated conids)`.
  - **`quotes.seedDailyQuotes()` (new)** — seeds a daily-close `quotes` row for curated names from `universe.last_price` + `daily_bars` (batched closes → 20pt sparkline), `canonical_source='daily'` with the bar date as an honest stale timestamp; **never clobbers** a live ib/finnhub row.
  - **`computeSet.loadComputeSet()`** — now resolves the latest curated date internally (no `asof` arg); callers `dipBounceCron` + `bandEngineCron` updated.
  - **Fresh-price firing gate** — `dipBounceCron.loadQuotes` reads `canonical_source` + `canonical_updated_at`; a scorer fires only when the quote is `ib`/`finnhub` and ≤15min old. Seeded/stale prices render but never fire.
  - **FE** — `useVirtualList` resolves the latest pool date + returns `{asof, stale}`; `VirtualList` shows an "as of <date>" badge / "data stale" banner (~4-day cap); `'daily'` added to the source type; CSS for the badge/banner.
  - **Migration `032_quotes_daily_source.sql`** — extends `quotes_canonical_source_check` to allow `'daily'`.
- **Verification:** server typecheck clean; client build clean; 194/194 server tests pass.
- **Manual prereqs for live-flip:** (1) **Apply `032_quotes_daily_source.sql`** in the Supabase SQL editor *before* the deploy (seedDailyQuotes writes `canonical_source='daily'`, which the old check rejects). (2) `git pull && ./bin/upside rebuild api` on the VPS; FE deploys via Vercel on push. The curated cron rebuilds at boot+90s.
- **Verification post-live-flip:**
  - `bin/upside-psql -c "select count(*) from curated_list;"` → non-zero after the curated cron's first tick (~90s after boot).
  - `bin/upside-psql -c "select canonical_source, count(*) from quotes group by 1;"` → a `daily` bucket appears (curated seed).
  - FE: Intraday/Swing tabs render rows, with an "as of <date>" badge when the pool isn't today's.
- **Follow-ups deferred:** (1) **Live curated pricing** — curated names only have the daily seed, so the fresh-fire gate keeps them from firing; they need a live intraday poller over the compute set before `signal_fires` fills from curated names (held/watchlist names already fire). This is the safe default (no stale recommendations) and has IB-budget implications (see Batch 13.3). (2) `newsSentimentCron` still keys its curated portion on today's date — repoint to `latestCuratedAsof` so the news chip covers the rendered set. (3) X8 (signal lab) consumes this data once fires accumulate.

### Batch X7 — News-as-signal: lexicon sentiment → bad_news flag + rank nudge (2026-06-07)
- Owner: claude
- Started: 2026-06-07 05:35 · Finished: 2026-06-07 06:00
- Commit: fbd2da6 / ed1020d / f123138 (code) · 8c69d21 (spec) · e57d130 (queue)
- **Design settled with user (2026-06-07):** risk-flags-**modifier** shape, *not* a universe trait — decided on API economics: there is no bulk news endpoint (`companyNews` is per-ticker), so it can only run over the small set (held ∪ watchlist ∪ curated), which is exactly the risk-flags working-set domain. **Scoring = LM-inspired finance lexicon** over `companyNews` headlines/summaries: Finnhub `/news-sentiment` was **probed live → 403 premium** on our free key (dead, deleted); EDGAR carries no sentiment; Alpha Vantage's free tier is too rate-capped; LLM scoring is the deferred upgrade. Also corrected a false premise in the old spec: `catalyst_reversal` keys off the **earnings calendar**, not news, so there was no dedup problem — news-as-signal is purely additive (it *is* the "news-sentiment sweep" that producer deferred).
- **What shipped:**
  - **Migration `031_news_sentiment.sql`** — `news_sentiment(conid, asof_date, score numeric, label text check bullish/neutral/bearish, article_count int, top_headline text, top_url text, source text default 'lexicon', computed_at)` PK `(conid, asof_date)` + `(asof_date desc)` index. Realtime-published (the FE chip subscribes), instrument-keyed grants (service_role write / authenticated read). The SSOT for the news fact, two consumers.
  - **`services/news/` (new)** — `lexicon.ts` (curated LM-inspired neg/pos finance term sets + a severe ×2 tier; space-padded boundary matcher so `lossless`≠`loss`) + `scoreNews.ts` (pure: 48h window, recency weight last-24h ×1 / 24–48h ×0.5, per-article saturated to ±1 so one hyperbolic headline can't dominate, weighted-mean aggregate ∈ ~[-1,+1], top headline = max-|contribution| danger-first). `scoreNews.test.ts` — 13 cases (boundary/phrase/severe matching, label thresholds, recency sign-flip, window exclusion, saturation, undated handling).
  - **`cron/newsSentimentCron.ts` (new)** — sole producer; **not IB-gated** (news is Finnhub-only, must work weekends). Working set = held ∪ active-watchlist ∪ today's curated_list (curated symbols resolved from `quotes`); per-ticker `companyNews(48h)` → score → upsert today's row (skips no-news names); 7-day retention. 12h cadence. Registered in `index.ts`.
  - **`bad_news` risk flag** — added to `RiskFlagKey` + `RiskFlagConfig.newsBearishScore` (default −0.35, Settings-tunable, bounds added in `routes/user`). `computeRiskFlags` raises it when `newsScore ≤ threshold`; **WARNING only** — NOT in `CORROBORATING`, so it never escalates to CRITICAL or clamps the LLM (a bad headline isn't a pump). Payload `{ news_score, threshold }` (numbers); the headline lives in `news_sentiment`. `RiskFlagInputs.newsScore` is optional via `buildRiskFlagInputs` (default null → no flag, so untouched callers keep working). `riskFlagsCron` batch-reads today's `news_sentiment.score` for the working set; `signalEngine` scores its *already-pulled* `companyNews` (freshest, zero extra call) so Analyze raises it on the spot. 3 new `computeRiskFlags` tests.
  - **FE** — `useVirtualList` joins `news_sentiment` (today, UTC) → a `news` field + a `weights.news × score × 100` composite-rank term (good lifts / bad sinks) + a `news_sentiment` Realtime subscription. `VirtualListRow` renders a directional `news ▲/▼` chip (headline in the title; neutral shows nothing). `utils/riskFlags` gains `bad_news` name/badge/explanation/threshold/priority. `config/virtualList` gains the `news` weight + `NEWS_RANK_SCALE`.
  - **Cleanup** — deleted the unreachable `newsSentiment()` from `finnhub.ts`.
- **Verification:** server `pnpm typecheck:server` clean (incl. scripts tsconfig); `vitest run` **194/194** (178 baseline + 13 scorer + 3 bad_news); client `pnpm build` clean. UI is user-driven (`feedback_user_drives_ui_testing`).
- **Manual prereqs for live-flip:** (1) **Apply `031_news_sentiment.sql`** in the Supabase SQL editor (additive — no ordering constraint with the deploy). (2) `git pull && ./bin/upside rebuild api` on the VPS; the FE deploys via Vercel on push. No env/Discord changes (`FINNHUB_API_KEY` already set).
- **Verification post-live-flip:**
  - `bin/upside-psql -c "select label, count(*) from news_sentiment where asof_date = (now() at time zone 'utc')::date group by label;"` — rows accumulate after the first `newsSentimentCron` tick (~60s after boot, then 12h). Works with **IB down** (weekend-testable).
  - A held/watchlist name with bearish recent headlines shows the amber danger badge + a "Negative news" Risk-flags row; the Intraday/Swing virtual lists show a `news ▲/▼` chip and the name's rank shifts with sentiment.
  - Analyze on a name with bad headlines raises `bad_news` immediately (on-demand top-up) and the flag appears in the LLM prompt context.
- **Follow-ups deferred:** LLM headline scoring (quality upgrade on the same table/consumers); headline into the Risk-flags section + the LLM prompt (today the section shows the score, the chip carries the headline); un-gate `riskFlagsCron` from IB by repointing it to X4's `daily_bars` (would refresh the flag off-hours too); forward-track `bad_news` raises into `signal_fires` (`risk_flag_bad_news`) once the risk-flag→signal_fires port lands.

### Batch X5 — Price SSOT: quotes is the only price table (2026-06-06)
- Owner: claude
- Started: 2026-06-06 11:40 · Finished: 2026-06-06 19:51
- Commit: 08c6d95 (code) · 15d37af (spec)
- **Scope decision (with user, 2026-06-06):** the strict option — **drop price AND P&L** from `positions`, not just `current_price`. `positions` holds holding facts only (conid / shares / avg_cost / realized_pnl / vwap / zone-state / entry provenance); market value + unrealized P&L are **recomputed** from `quotes.canonical_price × shares` by every reader. `quotes` is the single price home.
- **What shipped:**
  - **Migration `030_positions_price_ssot.sql`** — drops 9 columns from `positions`: `current_price`, `market_value`, `unrealized_pnl`, `unrealized_pnl_pct`, `today_change`, `today_change_pct`, `daily_return`, `portfolio_weight`, `portfolio_contribution`. ⚠️ **APPLY LAST** (see prereqs).
  - **`ibPricePoller` / `finnhubPricePoller`** — both keep computing price/market-value/P&L **in-memory** (still needed for the `quotes` mirror via `upsertQuote`, the profit-zone check, and the MTD anchor) but **stop persisting** them to `positions`. IB poller: new `toPositionRow()` projection writes only the holding-fact columns; change-detection now keys off vwap/shares/avg_cost/entry/zone (price removed); `finalizePortfolioMetrics` deleted. Finnhub poller: positions `.update()` now writes only `price_source` + `last_price_update_at` + zone fields; the portfolio-weight recompute block deleted; still mirrors the quote.
  - **`routes/portfolio`** — `/summary` recomputes `totalValue` + `totalPnl` from `positions ⨝ quotes` (`canonical_price × shares`); `/positions` orders by `symbol` (was `market_value`).
  - **`signalEngine`** — reads price from `quotes.canonical_price` by conid (IB snapshot still overrides when live); the held min-value gate + held P&L% are recomputed from it (was `position.market_value` / `unrealized_pnl_pct`).
  - **`riskFlagsCron`** — drops the `positions.current_price` read; price comes from the canonical quote (its existing quotes-fill loop already handled the null case).
  - **`usePositions` / `useTickerDetail`** — join `quotes` by held conid and recompute `currentPrice` / `marketValue` / `unrealizedPnL[Percent]` / `todayChange[Percent]` / portfolio weight / daily-return. `usePositions` now subscribes to **both** `positions` and `quotes` Realtime (quotes filtered client-side to held conids, 250ms-debounced reload) and sorts by computed market value. The `Position` / `PositionStats` types are unchanged, so `PositionCard` / `PositionStats` / `PortfolioHome` needed no edits.
- **Implementation forks / decisions:**
  - **Pollers keep price in-memory** rather than re-reading quotes — they already have the IB/Finnhub price they just wrote, so the zone check + MTD + quotes mirror reuse it; only the *persisted* `positions` columns shrank.
  - **Kept on `positions`:** `vwap_value` (a session metric, not a duplicated quote; `PositionCard` reads it), `realized_pnl` (broker fact), `trading_days_held` (date math). Only price-and-P&L-derived columns were dropped.
  - **Per-share `today_change` $ derived from `today_change_pct`** (`prevClose = price / (1 + pct/100)`) since `quotes` stores the % not the $ — exact, no extra column.
  - **FE computes live, server computes on read** — a Postgres view joining positions⨝quotes can't be Realtime-subscribed, so the hooks do the client-side join (mirrors `useVirtualList`); the summary route does it server-side on fetch.
- **Verification:** server `pnpm typecheck` clean (incl. scripts tsconfig); `vitest run` **178/178**; client `pnpm build` (tsc --noEmit + vite) clean. UI behaviour is user-driven (`feedback_user_drives_ui_testing`).
- **Manual prereqs for live-flip (ORDER MATTERS):**
  1. `git pull` + `./bin/upside rebuild api` on the VPS **and** let the Vercel FE deploy land (push already triggers it). The new code stops reading/writing the dropped columns.
  2. **THEN apply `030_positions_price_ssot.sql`** in the Supabase SQL editor. ⚠️ Applying it *before* the deploy would break the still-running old code that selects `market_value`. (Expand/contract: code first, drop last.)
  3. No Discord/env changes.
- **Verification post-live-flip:**
  - A held + watchlisted ticker shows **one** price (from `quotes`) on the position card, watchlist row, and TickerDetail; P&L + portfolio weight render and tick live as the quote updates.
  - `bin/upside-psql -c "\d positions"` shows the 9 columns gone; `select count(*) from positions;` unaffected.
  - Portfolio summary total value/P&L matches the sum of card values.
  - Analyze on a held name still gates on min market value + carries the correct P&L% in the prompt.
- **Follow-ups deferred:** X7 (news-as-signal, specced). The dip-bounce (X1/X2), risk-flags (R1/R2), daily_bars (X4), and price-SSOT (X5) tracks are all shipped; remaining un-done: Batch C remainder, Batch 15 (alerts feed), 14h, 13.9, 16.

### Batch X4 — daily_bars layer: Polygon-primary daily-grain SSOT (2026-06-06)
- Owner: claude
- Started: 2026-06-06 11:20 · Finished: 2026-06-06 11:35
- Commit: f344d70 (code) · 0089fb1 (spec)
- **What shipped:** daily OHLCV bars were the only data type with no non-IB fallback, so the curated list / swing pack / sparkline all died when IB `/iserver/marketdata/history` 503'd (weekends, off-hours). This makes **Polygon grouped-daily the daily-grain SSOT** (`daily_bars` table) and demotes IB to live-only for daily grain. Subsumes the old "volume-only precompute" X4 — `universe.last_avg_volume` is now one derived column of this layer.
  - **Migration `029_daily_bars.sql`** — `daily_bars(conid, date, o/h/l/c numeric, v bigint, source text default 'polygon', computed_at)` PK `(conid, date)` + `(date)` index. `conid` = `universe.real_conid`. NOT Realtime-published (server-side consumers only). Grants: service_role write + authenticated/anon select (instrument-table convention). **`universe.last_avg_volume` widened `integer → bigint`** (high-volume sub-dollar names overflow int). **`refresh_universe_avg_volume()`** SQL function — recomputes `last_avg_volume` = 30d median daily volume per conid (`percentile_cont`) in one statement.
  - **`services/dailyBars.ts`** (new) — `loadDailyBars(conid, lookbackDays=90)` reads the SSOT oldest→newest (matches `RawIbHistory.data` order so consumers swap in cleanly) + pure `recentWeekdays(n, asof)` (weekend-skipping date list) + `buildDailyBarRows(date, grouped, symbolToConid, source, computedAt)`. `dailyBars.test.ts` (6 cases — weekday math incl. Monday→Friday, conid mapping + volume rounding).
  - **`cron/universeQuoteProducer.ts`** (extended) — now does two jobs off the same Polygon pulls: (1) the original `universe.last_price/last_volume` refresh, (2) `daily_bars` — appends the **most-recent weekday's** bar each run (weekend-safe: a Monday run targets Friday) + a **30-day bootstrap** on missing dates (rate-limited 13s/call for the free 5/min tier, ~30 calls one-time, ~1 steady-state since the primary pull is reused). Yahoo gap-fill writes `daily_bars` too (`source='yahoo'`, `real_conid` threaded into the job payload). After writing bars: `refresh_universe_avg_volume()` RPC + 45-day retention delete. **Universe load paginated** (`.range()`) so the whole ~3-5k IN universe is covered regardless of the PostgREST max-rows cap. Date-coverage checked via cheap per-date `head:true` count queries.
  - **Repointed consumers off IB history → `daily_bars`:** `curatedListCron.dailyMetrics` (and **dropped its IB gate** — the headline weekend fix); `dipBounceCron.refreshPacks` (swing feature pack, no longer needs IB up mid-session); `routes/marketdata` sparkline (reads `daily_bars` first, **IB fallback** for held names outside the universe / pre-first-run).
- **Implementation forks / decisions:**
  - **Date-driven backfill, not per-conid** — coverage is tracked at the trading-date grain (grouped-daily is per-date), so a missing date triggers one grouped pull that writes all universe matches. Holidays (Polygon returns empty) get cheaply re-checked each run (≤1-2 wasted calls); no persistence of "empty dates" needed. **Known limitation:** a *newly-added* universe ticker only gets forward coverage (already-fetched dates are skipped), so it reaches 30 bars in ~6 weeks — fine for the stable bulk of the universe; a periodic full re-bootstrap is a deferred option.
  - **`band engine` + `entry-zone cron` NOT repointed** — both need intraday 5-min bars (Polygon free is daily-only), so they stay inherently IB-gated. `entryZonesCron`'s sparkline-piggyback write to `quotes.sparkline_closes` also stays (it's a side effect of an already-IB-gated cron). Documented in `data/sources.md`.
  - **`last_avg_volume` = 30d median** (despite the "avg" name) — one definition of "average daily volume" across the system (matches the X3 curated gate). Widened to bigint to avoid overflow.
- **Verification:** `pnpm typecheck` clean (incl. scripts tsconfig); `vitest run` **178/178** (6 new dailyBars). Live verification is **weekend-testable** (the point of the batch): Polygon serves historical data with IB down.
- **Manual prereqs for live-flip:**
  1. **Apply `029_daily_bars.sql`** in the Supabase SQL editor. ⚠️ migration needed.
  2. Ensure `POLYGON_API_KEY` is set on the VPS `.env` (already required by the existing producer; without it the producer skips).
  3. `./bin/upside rebuild api` on the VPS.
- **Verification post-live-flip (works on a weekend, IB down):**
  - `bin/upside-psql -c "select source, count(*), count(distinct conid), count(distinct date) from daily_bars group by source;"` — Polygon rows accumulate; ~30 distinct dates after the first bootstrap run (~6.5 min), 1 new date/day after.
  - `bin/upside-psql -c "select count(*) from universe where last_avg_volume is not null;"` climbs toward the IN count after `refresh_universe_avg_volume`.
  - `bin/upside-psql -c "select count(*) from curated_list where asof_date=(now() at time zone 'utc')::date;"` builds **without IB** once `daily_bars` + today's `trait_scores` exist (the weekend-gap fix). Boot logs: `[curatedListCron] starting, 12h cadence (daily_bars-backed)`.
  - TickerDetail sparkline renders for held universe names with IB off.
- **Follow-ups deferred:** periodic full daily_bars re-bootstrap for newly-added tickers; X5 (price SSOT — `quotes` only); X7 (news-as-signal). The intraday-grain IB dependency (band engine / entry zones / live snapshot) is inherent to Polygon-free and not a gap to close here.

### Batch X6 — Earnings calendar: single shared daily pull (2026-06-06)
- Owner: claude
- Started: 2026-06-06 11:04 · Finished: 2026-06-06 11:07
- Commit: 1a5028c
- **What shipped:** the low-hanging-fruit win from the data audit — `catalystReversalProducer` (3d lookback) and `postEarningsDriftProducer` (5d) each called `earningsCalendarRange` daily, two Finnhub calls for overlapping windows. New **`server/src/services/earningsCalendar.ts`** → `getEarningsWindow()` memoizes one call per UTC day for the widest window (`EARNINGS_WINDOW_DAYS = 5`), coalesces concurrent callers onto one in-flight request, and doesn't poison the cache on failure (next call retries). Both producers read it and filter to their own lookback client-side → **2 calls/day → 1**. In-memory memo (both producers share the Node process); no table needed.
  - Files: `services/earningsCalendar.ts` (new) + `earningsCalendar.test.ts` (new, 3 cases: memo / concurrent-coalesce / failure-retry); `cron/catalystReversalProducer.ts` + `cron/postEarningsDriftProducer.ts` (swap `earningsCalendarRange` import → `getEarningsWindow` + per-lookback filter; drop unused `to`).
  - Catalog: `spec/data/sources.md` Obs 6 + `consumers.md` Obs 4 marked resolved.
- **Verification:** `pnpm typecheck:server` clean; `vitest run` **172/172** (3 new).
- **Context:** one of the data-architecture decisions persisted in `5a1103c` (queue X4–X7 + `spec/signals/news-signal.md`). Remaining queued: **X4** daily_bars layer (Polygon daily-grain SSOT — the weekend-gap fix), **X5** price SSOT (`quotes` only), **X7** news-as-signal (deferred).

### Batch X3 — Curated-list volume gate: median ADV from IB bars (2026-06-06)
- Owner: claude
- Started: 2026-06-06 07:56 · Finished: 2026-06-06 08:00
- Commit: 1736ffb
- **What shipped:** the fix that lets `curated_list` actually build — discovered during the X1/X2 live-flip when the virtual lists stayed empty. **Root cause:** `curatedListCron.loadSeeds` pre-filtered candidates on `universe.last_avg_volume`, which is NULL for all 5,307 universe rows. Nothing ever populates it — `universeCron` writes `null`, `marketCapRefreshCron`'s header claimed a "+ last_avg_volume bootstrap" that was never implemented (its `.update()` only writes `last_market_cap_m`; Finnhub `profile2` carries no avg volume). So 0 seeds passed the gate → empty list → both virtual tabs stuck in "warming up". The IB `/iserver/marketdata/history` 503s seen at the same time were a *separate* off-hours (≈03:10 ET) issue, not the blocker.
  - **`cron/curatedListCron.ts`** — `loadSeeds` drops the `universe` join + volume pre-filter; returns all `intraday_range_trader` seeds, top `MAX_CANDIDATES` by score. `dailyAtrPct` → `dailyMetrics`, which from one daily-bar pull (`ibHistory 3m/1d`) computes BOTH the ATR% and the **30d median ADV** (`median` of the last-30 `bars[].v`, finite & >0). `CuratedCandidate.avgDailyVolume` is now the bar-derived median; the early-stop counter + `buildCuratedList` gate on `medAdv >= MIN_AVG_VOLUME` as before.
  - **`services/curatedList/buildCuratedList.ts`** — gate logic unchanged (already gated on `avgDailyVolume`); header comment updated. Its 5 vitest cases still pass (the gate contract is intact).
  - **`config/curatedList.ts`** — `MIN_AVG_VOLUME` comment clarifies the bar-derived source.
  - **`cron/marketCapRefreshCron.ts`** — dropped the misleading "+ last_avg_volume bootstrap" header line.
- **Design decisions (settled with the user):**
  - **A over B/C.** A = median ADV from the IB bars already pulled for ATR (zero marginal API cost, internally consistent with ATR, honors the gate's documented "30d median" intent). B (precompute `universe.last_avg_volume` from Polygon) deferred to **Batch X4** — its payoff is scale/robustness (cheap universe-wide pre-filter, survives IB outages, feeds `catalystReversal`), not data quality. C (single-day `last_volume` fallback) **rejected** — noisy, not decision-grade.
  - **No fallback when IB history is down** — the list stays empty rather than admit low-quality-gated names. Quality-first, per the user's "don't just show stuff."
- **Spec:** `spec/signals/curated-list.md` → Membership rule + new *Volume source (2026-06-06)* note (commit 8924f43).
- **Verification:** `pnpm typecheck:server` clean; `vitest run` **169/169**. Live verification pending — needs the deploy + IB history available (the curated cron is 12h-from-boot + boot-kick, IB-gated). After `git pull && ./bin/upside rebuild api` on the VPS, `curated_list` should climb above 0 once a probe cycle runs with history serving (likely at US pre-market/RTH, not the 03:10 ET off-hours window where history was 503ing).
- **Follow-up:** Batch X4 (deferred) — precompute `universe.last_avg_volume`.

### Batch X2 — Watchlist virtual lists: Intraday / Swing (2026-06-06)
- Owner: claude
- Started: 2026-06-06 05:06 · Finished: 2026-06-06 05:25
- Commit: 0ff573e
- **What shipped:** the FE surface for X1's dip-bounce track — two always-present Upside-curated virtual sub-tabs (Intraday ✨ / Swing ✨) leading the Watchlist strip, rendering `curated_list ∪ event-trait names` as living top-N leaderboards. Pure FE consumer of X1's outputs; **no migration, no schema/engine/cron change.**
  - **`config/virtualList.ts`** (new) — composite-rank weight constants for both lists (`INTRADAY_WEIGHTS` / `SWING_WEIGHTS`), `VIRTUAL_LIST_TOP_N = 30`, `FIRE_LIVE_WINDOW_HOURS` (4h / 24h, matching the BE cooldowns), `HIT_RATE_WINDOW_DAYS = 30`, `HIT_RATE_DEF` (intraday +2h vs +1%, swing +3d vs +5% — mirrors `signal_hit_rate_30d`). All flagged as **calibration seeds** — no forward-tracked data exists yet; retune from `signal_hit_rate_30d` after ~a month of real fires.
  - **`hooks/useVirtualList.ts`** (new) — `useVirtualList(kind)`. Union members = `curated_list` (today, UTC → `dip` reason + `intraday_range_trader_score`) ∪ `trait_scores` (today, UTC, `catalyst_reversal` → `catalyst`/both lists, `post_earnings_drift` → `post-earnings`/swing). Joins `quotes` (conid→symbol + price + change + sparkline), `band_state` (latest session_date per conid → walking-band chip + marker-prefill low), `signal_fires` (live ⚡ within cooldown + the 30d hit-rate numerator), `signal_outcomes` (per-conid rolling-30d hit-rate, recomputed client-side since the view aggregates per-kind). Composite rank per kind, top-N, **debounced** Realtime (curated_list / trait_scores / band_state / quotes) coalescing bursts into one reload (~250-300 conids).
  - **`components/Watchlist/VirtualListRow.tsx`** (new) — shared watchlist-row layout (symbol · sparkline · price/change/source) + the virtual extras: ⚡ just-fired marker, `why` reason chips, walking-band chip (regime + vol-scalar; title carries next low/high), rolling-30d hit-rate column (`%` + `n<sample>`, or `—` when no graded fires — honest absent, not zero), and the shared `DangerBadge`. Tap → TickerDetail; long-press → add-marker sheet.
  - **`components/Watchlist/VirtualList.tsx`** (new) — leaderboard body: loading / warming-up empty state / ranked rows; long-press routes up to the page's `MarkerSheet` prefilled at the band low (`at_or_below`, "from walking band").
  - **`pages/Watchlist.tsx`** (edit) — selection model now spans virtual tabs (`virtual:intraday` / `virtual:swing`) + imported list ids; **Intraday is the default landing tab**. `SubTabStrip` renders the two virtual tabs first (can't be hidden), then active imported lists. The first-run "Import from IB" CTA became a slim `ImportHint` banner under the strip so the screen is never blank (virtual tabs always render).
  - **`styles/components.css`** (edit) — reason chips (dip→buy / catalyst→event / post-earnings→watch palette), ⚡ fired icon, walking-band chip, hit-rate column (good/ok/low/empty tiers), virtual-tab accent, import-hint banner.
- **Open-question resolutions (the three from BUILD_QUEUE "settle at claim time"):**
  - **Composite weights** — seeded named constants (character signal highest, then live-fire boost, then hit-rate); documented as calibration, not data-tuned (no data yet). Both lists draw the **same union** and differ only by rank lens + which reason dominates — simplest robust shape; low-relevance names sink below the top-30 cut rather than needing hard per-list membership rules.
  - **Hit-rate column shape** — `%` + sample size (`n<k>`), `title` tooltip naming the 30d window; `—` when genuinely absent (per `feedback_show_data_not_dashes`).
  - **"On a virtual list" chip on imported rows** — **deferred** (additive imported-row tweak; not built v1).
- **Implementation forks / deferrals:**
  - **`universe` is not granted to `authenticated`** (service_role only) — so event membership comes from `trait_scores` (FE-readable) instead of `universe.auto_promoted`, and conid→symbol comes from `quotes` (not `universe.symbol`). A union name with no quote row yet is skipped (engine hasn't priced it). No grant/migration added (X2 is pure-FE scope).
  - **"Add to one of my watchlists" long-press affordance deferred** — there is no `watchlist_items` insert endpoint, and manual items have IB-sync-wipe implications (a real feature + BE route + RLS, not a pure-FE tweak). Long-press wires the **Set marker** affordance only (prefilled at band low). Add-to-watchlist queued as a follow-up.
  - **"Retire the Screener tab" was already a no-op** — S4 was superseded by X2 before being built, so no `Screener.tsx` / route / nav tab existed to remove. Nav stays Portfolio · Watchlist · Alerts · Settings.
  - **Walking-band chip popover** — v1 shows next low/high via the chip `title` (lightweight); the full tap-popover (à la `EntryZoneCluster`) is a polish follow-up.
- **Verification:** client `pnpm build` (tsc --noEmit + vite) **clean**. No server change (no typecheck/test delta). UI behaviour is user-driven (per `feedback_user_drives_ui_testing`) — needs live data to render (see below).
- **Manual prereqs for live-flip:** none beyond **X1's** (apply `028_dip_bounce.sql`; rebuild VPS; IB connected so `curatedListCron` + `trait_scores` + `band_state` populate). The Watchlist FE deploys via Vercel on push. Until `028` is applied + the engine has run with IB, both virtual tabs show the "still warming up" empty state.
- **Verification post-live-flip:**
  - Watchlist strip leads with **Intraday ✨ / Swing ✨**; tapping each shows a ranked leaderboard once `curated_list` / `trait_scores` have rows.
  - Rows show reason chips, a walking-band chip when `band_state` has a row, a ⚡ marker on a name with a `signal_fires` row inside cooldown, and a hit-rate `%`+`n` once `signal_outcomes` accumulate (else `—`).
  - Long-press a virtual row → add-marker sheet prefilled at the band low.
- **Follow-ups deferred:** add-to-watchlist affordance (needs BE insert route + IB-sync decision); "on a virtual list" chip on imported rows; full walking-band tap-popover; composite-weight + hit-rate recalibration from real `signal_hit_rate_30d` data after ~a month.
- **What's next:** the dip-bounce (X1/X2) + risk-flags (R1/R2) tracks are both FE-complete. Remaining un-done: Batch C remainder (per-marker cooldown UI, `at_or_above` routing, port band-touch/marker fires onto `signal_fires`), Batch 15 (alerts feed + settings), 14h (live leg tracking + Refine), 13.9, 16. No single "next" pointer — ask the user.

---

**Older completed batches archived in [`CLAIMS_DONE.md`](CLAIMS_DONE.md)** — the screener + dip-bounce + risk tracks (X1, R1/R2, S3, M1, S2, S1.5, S0.5, S0.3, S1), and before them Polish slices, Batch C first slice, Tooling slice, Batch B, A1/A2/A+, 14a/14c/14e/14f/14.5, 13.x, 12, 11, 10, 8, 9, 7.5/7, 6, 5, 4, 3, 2, 1, plus the 2026-05-24 Settings + Discord-observability slices. This file keeps In progress + Known issues + the ~5 most recent completed; older ones move down periodically to stay under the Read-tool 25k single-call cap.

