# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

### Batch M1 — Agent context efficiency (measurement + structural slim-down)
- Owner: claude
- Started: 2026-06-03 05:46

### Batch 14g — Single-direction playbook engine
- Owner: claude
- Started: 2026-05-26
- **Design locked + spec written** (`signals/playbook.md` rewritten, `screens/_design-system.md`/`flows.md` updated). Replaces the unified SELL+BUY analysis (14a) with a single-direction **playbook**. Scope for 14g (Fresh Analyze only):
  - **Direction by holding:** held → SELL playbook, not-held → BUY. MVP held-only → SELL today.
  - **Computed feature pack** (`technicals.ts`): pivots, swing highs/lows, N-day/52w highs/lows, ATR, SMA/EMA, RSI(+state), MACD(+cross), Bollinger(+%B/bandwidth), VWAP+distance, relative volume, position-relative distances. The LLM anchors legs to these levels — must not invent prices. (Biggest quality lever.)
  - **Playbook output** (Zod): `{ indicatorAnalysis, reasoning, signal: { direction, signalQuality, motivation, horizon: intraday|multiday, horizonWindow, legs:[{action, price, condition, confidence, reasoning}] } | null }`. Per-leg confidence; horizon-only timing (no per-leg timing).
  - **Persistence:** one `analyses` + **one** `signals` row; leg[0] → existing `price_range_*`/`optimal_price`; full legs+horizon → new `playbook jsonb`. Migration `010_playbook.sql` (also adds `analyses.refined_from_analysis_id` for 14h).
  - **Prompt:** single-direction, level-anchored, with `contextualTriggers.inProfitTakingZone` wired in (resolves the 14c-deferred prompt piece).
  - **FE:** render the playbook (legs + per-leg confidence + reasoning) in SignalSection; single pill on cards.
  - Expiry: intraday → end of session; multiday → window.
- Honesty caveats baked into spec: specific ≠ accurate (raises 14b's value); model strength matters (revisit provider later, not in 14g).
- **Implementation built + pushed (commits 8631379 code, ce6166f spec/schema).** Migration `010_playbook.sql` (signals.playbook jsonb + analyses.refined_from_analysis_id); `technicals.buildFeaturePack` (pivots / swing H-L / 20d+52w H-L / round magnets / ATR / SMA-EMA + price-vs-MA / structure / RSI+state / MACD+cross / Bollinger+%B+bandwidth / VWAP+distance / relative volume / position-relative); `llm.ts` direction-specific Zod + level-anchored single-direction prompt with zone trigger wired in; `signalEngine` rewritten (direction by holding, one analyses + one signals row, leg[0]→price_range_* via half-ATR band, horizon-driven expiry via new `marketHours.endOfRegularSessionEtIso`); FE SignalPill→single leg[0] price, SignalSection renders ordered legs (action·price/condition·confidence·why) under a horizon header (forward-compatible 14h status glyphs). Server+client typecheck + client build clean; `buildFeaturePack` runtime-checked on full/empty/3-bar inputs.
- **First live test (BBAI, 2026-05-27):** backend produced a well-formed 3-leg round-trip playbook (sell 4.29 → rebuy 4.13 → resell 4.48, conf 80→60→40, level-anchored) — structure validated. Two issues found + fixed: (a) float noise in `price_range_low` (4.145000…05) — `legToRange` now rounds to 4dp (commit 68fe0ea); (b) "sell now" bias — model tagged a resistance target above price as `at_or_below` (→ act-now) and the zone line ("take profit here, or hold?") nudged the same way. Prompt de-biased (commit 595cb90): **geometric** condition rule (level-vs-current-price, not SELL/BUY mirror — addresses user's BUY-semantics concern), leg 1 framed as a resting order, zone trigger reframed as neutral context, + a nudge to weigh coiling/fresh-low/rising-relvol structure before mean-reverting. "No playbook visible, just thesis" diagnosed as a **stale FE** (old pre-14g bundle / PWA service-worker cache) — DB had the full playbook.
- **Re-test verified (2026-05-27, post-prompt-fix):** BBAI 2-leg playbook (sell at_or_above 4.29 = pivot resistance → rebuy at_or_below 4.06 = support, conf 80→40, signalQuality 60, multiday 1-2 weeks). Geometric condition rule landed (leg 1 = "wait for the resistance push," not sell-now). Float noise gone. The remaining gap is *judgment quality*: the `structure` feature mislabels coiling-near-the-lows as a downtrend (BBAI's "lower-lows" label came from a last-two-swings comparison ignoring that the absolute lowest swing was the OLDEST, with recent low above it = a higher low off the bottom). And a separate data-correctness bug surfaced — three analyses captured ~$4.17 over 10h while live was $4.37 because `signalEngine` was reading a stale cold IB snapshot over the poller's fresh value. Both findings are spec'd as deferred follow-ups (`spec/roadmap.md` → Track 1 → Deferred; `spec/signals/playbook.md` → Freshness guard). Implementation waits behind the watchlist pivot.
- **Closed under the 2026-05-28 pivot.** Engine itself is validated; remaining sharpening lives in the deferred queue.

### Batch 14h — Live leg tracking + Refine follow-up (planned, after 14g)
- Owner: claude (queued)
- **Half A:** pollers mark each active playbook leg `hit/missed/pending` + actual extreme on every price write (no LLM, no cron) → mechanical "on track / diverged"; feeds 14b.
- **Half B:** a second, manually-triggered **Refine** analyze mode — sends fresh feature pack + prior playbook + realized outcomes + anti-anchoring instruction → revised playbook; supersedes + records `refined_from_analysis_id`. Two buttons when an active signal exists (Refine / Re-analyze fresh).
- Deliberately split from 14g: validate base playbook quality on real tickers before building the refinement loop.

## Known issues (deferred fixes)

- **Signal quality poor → 14b + 14d deferred (2026-05-26)** — the unified SELL+BUY analyses we're getting are low quality. Hypothesis: the prompt asks for both directions at once, splitting the LLM's focus; switching to **single-direction** analysis (ask for SELL *or* BUY per run, not both) may sharpen them. Until signals improve there's no point measuring them, so **Batch 14b (accuracy cron) is deferred**, and **Batch 14d (signal-range pings) is deferred** with it. Revisit the single-direction redesign before un-deferring 14b/14d. (User call, 2026-05-26.)
- **TickerDetail loading/error states say "coming soon"** — `TickerDetailPage` reuses the `ComingSoon` placeholder for loading/error/not-held, so opening a position briefly shows "Loading SYMBOL… · SYMBOL — coming soon". Needs real skeleton/error/empty states. Folds into Batch 16 (loading/error/empty sweep). Spec: `screens/_design-system.md` → Screen 2 note.
- **TickerDetail Indicators section empty** — `useTickerDetail` hardcodes `indicators: []`; the data exists on `analyses.indicator_snapshot` (Batch 14a) but isn't surfaced. Wants a future batch to render the latest analysis's indicators (incl. a pre-Analyze empty state). Spec: `screens/_design-system.md` → Indicators note.

## Completed

### Batch S2 — Screener trait scoring engine (2026-06-02)
- Owner: claude
- Started + Finished: 2026-06-02
- **What shipped:** the three traits per `spec/signals/screener-universe.md` (intraday_range_trader, catalyst_reversal, post_earnings_drift) with the caching + staggering + event-gated architecture so daily IB usage stays ~15-20 min (on-demand IBeam compatible; not blocked on 13.3). Discord first-fire ping for the two event-shaped traits; the baseline range-trader trait scores silently (band-touches will carry its actionable events when S3 lands).
  - **Migration `024_trait_scores.sql`** — `trait_scores(conid, trait, asof_date, score, payload jsonb, computed_at, last_fired_at, PRIMARY KEY (conid, trait, asof_date))` per spec/schema.md. Realtime publication for the Screener tab (S4). Indexes for "top-N per trait today" + per-conid lookup. `conid` here references `universe.real_conid` (S1.5), not the synthetic PK.
  - **Migration `025_screener_jobs_result.sql`** — adds `result jsonb` to `screener_jobs` so multi-stage producer flows (catalyst Stage 1 → Stage 2) can hand off computed values via the job row. Existing actions (resolve_conid, fallback_yahoo_quote, noop) ignore the column. Queue.ts `markDone(id, result?)` and worker.ts pass-through wired in alongside; `JobHandler` return type is now `Promise<void | Record<string, unknown>>`.
  - **`services/screener/traits/intradayRangeTrader.ts`** — pure scorer per spec: p50 ≥ 2%, p25 ≥ 1% (derived as p50/2 until the column lands), sample ≥ 30, envelope tightness ≤ 1.5, sub-$30/sub-$10 price bonus. Payload ready-to-render: `{p25, p50, p75, sample_size, today_open_band_low}`. 10 vitest fixtures green.
  - **`services/screener/traits/catalystReversal.ts`** — two pure evaluators. **Stage 1**: vol-multiple ≥ 3× AND max(|gap %|, |intraday move %|) ≥ 5% — derived from the IB snapshot fields. **Stage 2**: A (beaten-down: below SMA200 OR > 30% off 52w high OR RSI<30 within last 30 sessions) ∧ B (Stage-1 carryover); Wilder's RSI(14) implementation inline. Score composite of vol × move × depth, saturating at sane ceilings. 13 vitest fixtures green.
  - **`services/screener/traits/postEarningsDrift.ts`** — pure scorer (pop ≥ +2%, days_since ≤ 5; pop magnitude 60pts saturating at +5%, freshness 40pts decaying linearly) + `findReportDayPop` helper that pulls the report-day close vs prior close from daily bars. 11 vitest fixtures green.
  - **`cron/intradayRangeTraderProducer.ts`** — 24h cadence, inline compute (no queue indirection — pure DB join + score over universe IN ⨝ intraday_stats by real_conid). Silent trait, no Discord ping.
  - **`cron/catalystReversalProducer.ts`** — three-stage producer + two `ib`-pool worker actions (`eval_catalyst_stage1` + `eval_catalyst_stage2`). Stage 0 inline (bulk `/calendar/earnings` for the last 3 trading days); news-sentiment sweep deferred per spec note (one-call Finnhub bulk avoids the 5,300 × per-symbol news call pattern). Stage 1 → 2 handoff carries vol_multiple/move/gap via the new job.result column. Stage 2 survivors: trait_scores upsert + universe.auto_promoted=true + first-fire `notifyTraitFirstFire` gated by atomic `last_fired_at IS NULL` UPDATE.
  - **`cron/postEarningsDriftProducer.ts`** — bulk Finnhub earnings calendar + per-reporter `eval_post_earnings_drift` jobs on `ib` pool (ibHistory '1m' '1d'). Worker returns `{report_day_pop_pct, days_since_earnings, today_close}`; producer scores + upserts + first-fire ping.
  - **`cron/intradayStatsCron.ts` extension** — adds `staggeredUniverseConids()` so each day refreshes 1/7 of the Ring-1 IN universe (`real_conid % 7 = day_of_week`), giving ~430 tickers/day × ~1 sec IB = ~7 min IB/day weekly coverage of every universe ticker's intraday_stats. Watchlist tickers still get their existing daily coverage; the universe slice is added on top.
  - **`cron/marketCapRefreshCron.ts`** — weekly cadence; re-pulls Finnhub `/stock/profile2` for every Ring-1 IN row to refresh `last_market_cap_m`. Filter re-evaluates at next nightly universeCron.
  - **`cron/traitScoresRetention.ts`** — daily sweep deletes trait_scores past shelf-life (1d / 3d / 5d for intraday_range_trader / catalyst_reversal / post_earnings_drift respectively).
  - **`services/notify.ts:notifyTraitFirstFire(trait, symbol, score, payload)`** — routes catalyst_reversal + post_earnings_drift to `#upside-catalyst-alerts` (env `DISCORD_WEBHOOK_CATALYST_ALERTS`). Trait-specific summary line (vol-multiple + move + off-52w-high + basis; or pop + days-since-earnings).
  - **`services/finnhub.ts`** — extended with `earningsCalendarRange(from, to)` — the bulk no-symbol variant of `/calendar/earnings` (existing `earningsCalendar(symbol)` stayed for the per-symbol use cases).
  - **Boot wiring** in `server/src/index.ts` — five new starters joined the cron set (intradayRangeTraderProducer, catalystReversalProducer, postEarningsDriftProducer, marketCapRefreshCron, traitScoresRetention).
- **Vitest coverage** (34 new cases, 94 total green): intradayRangeTrader 10 (textbook range, threshold rejections, envelope tightness, explicit-p25 path, price bonus tiers, band-low computation, missing-open path), catalystReversal 13 (Stage 1 qualified/rejected combos including negative gap; rsiSeries warm-up + uptrend/downtrend extremes; Stage 2 A ∧ B and each A sub-clause; Stage-1 carry-through), postEarningsDrift 11 (score gates, freshness premium, saturation cap; findReportDayPop happy path + every failure mode).
- **Manual prereqs for live-flip:**
  1. Apply migrations `024_trait_scores.sql` + `025_screener_jobs_result.sql` in the Supabase SQL editor.
  2. Create Discord channel `#upside-catalyst-alerts`, generate a webhook, set `DISCORD_WEBHOOK_CATALYST_ALERTS` in VPS `.env`.
  3. `./bin/upside rebuild` on the VPS.
- **Verification post-live-flip:**
  - Boot logs show `[intradayRangeTraderProducer]`, `[catalystReversalProducer]`, `[postEarningsDriftProducer]`, `[marketCapRefreshCron]`, `[traitScoresRetention]` starting at 24h / 7d cadences.
  - After first tick (~6 min boot): `bin/upside-psql -c "select trait, count(*) from trait_scores where asof_date=current_date group by trait;"` shows three rows. `intraday_range_trader` typically 100s; `catalyst_reversal` + `post_earnings_drift` smaller (event-dependent — may be zero on a quiet earnings day).
  - `bin/upside-psql -c "select worker_pool, status, count(*) from screener_jobs where action like 'eval_%' group by 1,2;"` shows the Stage-1/Stage-2 + post-earnings-drift queue draining when IB is connected.
  - First catalyst_reversal / post_earnings_drift hit on a known reporter day fires one ping in `#upside-catalyst-alerts` per ticker per day (gated by `trait_scores.last_fired_at`).
  - Spot check: `bin/upside-psql -c "select symbol, trait, score, payload from trait_scores ts join universe u on u.real_conid=ts.conid where asof_date=current_date order by score desc limit 20;"` shows top scorers + their FE-ready payloads.
- **Out of scope / follow-up:**
  - Stage 0 news-sentiment sweep — current Stage 0 is earnings-only; news pre-filter requires either a daily per-universe `/news-sentiment` budget (~5,300 calls/day, doesn't fit free tier) or a Stage -1 RSS firehose. Spec'd as a follow-up alongside the broader RSS work (`spec/roadmap.md` → Screener deferred).
  - `last_avg_volume` weekly 30-day median — Stage 1 currently uses `last_volume` (yesterday's single-day shares) as the baseline. Less robust than a median; spec note in catalystReversal.ts to swap when the weekly volume-median producer lands.
  - Dynamic universe inclusion (3× volume gap promotion from filtered-OUT pool back into the screener) — catalyst_reversal stays inside Ring-1 IN for v1 to limit Stage-1 IB cost. Spec'd at `signals/screener-universe.md` → Dynamic universe inclusion as a follow-up.
- **What's next:** S3 (band engine — adaptive layers on top of the static intraday-stats band). S4 (FE Screener tab) follows after S3.

### Batch S1.5 — Real IBKR conid resolution for universe tickers (2026-06-02)
- Owner: claude
- Started + Finished: 2026-06-02
- **What shipped:** real IBKR conid resolution for the universe via `ibSecdefSearch` + S0.3's job queue. Producer enqueues per-universe-row jobs on the `ib` worker pool; worker drains when IB is connected, writes `real_conid` back to the row. Initial backlog (~3,000 universe rows) drains in ~10 min at sustainable secdef pacing; steady-state ~few new jobs/week.
  - **Migration `023_universe_real_conid.sql`** — adds `real_conid bigint` (null until resolved) + `auto_promoted bool default false` (the catalyst_reversal Stage-2 promotion flag, used by S2). Two partial indexes: `universe_real_conid_pending_idx` for the producer's claim query (`filter_result='in' AND real_conid IS NULL`), `universe_real_conid_idx` for downstream joins. The synthetic FNV `conid` PK stays for in-table identity + idempotent universeCron re-runs; `real_conid` is the cross-table join key.
  - **`server/src/services/screener/conidPicker.ts`** — pure `pickUsStockMatch(results)` extracted into its own file (separate from conidResolver to keep vitest happy without supabase/env at module-init, same pattern as jobs/keys.ts). Filters to `description ∈ {NASDAQ, NYSE, AMEX}` with at least one `secType='STK'` section; rejects non-numeric or zero conids; first-listed wins for dual US listings. Live IB shapes captured 2026-06-02 informed the test fixtures: MNTS (MOMENTUS NASDAQ vs SCHIEHALLION LSE), REPL (Replimune NASDAQ vs RUDRABHISHEK NSE).
  - **`server/src/services/screener/conidResolver.ts`** — `resolveConid(symbol)` calls `ibSecdefSearch` + delegates to `pickUsStockMatch`. Throws on IB error (network / 401 / 503) so the worker framework marks failed; returns null on "IB responded fine, no US STK match" so the caller decides.
  - **`server/src/cron/conidResolutionProducer.ts`** — 24h cadence, 5-min boot delay. Per tick: load `universe WHERE filter_result='in' AND real_conid IS NULL` (capped at 5,000), enqueue `resolve_conid` jobs onto `ib` pool, drain prior-cycle done/failed. Failed-job retry policy: up to 2 attempts (covers transient IB hiccups), then `finalizeFailure` for genuinely unresolvable symbols (delisted, foreign-only listings).
  - **Worker action `resolve_conid`** registered into `ibRegistry`. Handler: read `{universeConid, symbol, mic}`, call `resolveConid(symbol)`, write `real_conid` to the universe row by synthetic conid PK, mark done. Null result → throw → marked failed → producer's retry/give-up policy applies.
  - **Boot wiring** in `server/src/index.ts` — `startConidResolutionProducer()` joins the existing cron set.
- **Vitest coverage** (`conidResolver.test.ts`): 9 cases — US match when foreign exists, all-foreign null, NYSE/AMEX listings accepted, first-US wins on dual listings, US-description without STK section rejected, non-numeric/zero conid rejected, empty response null, garbage sections array tolerated. Pure picker surface; live `ibSecdefSearch` exercised by the cron after deploy.
- **Manual prereqs for live-flip:**
  1. Apply migration `023_universe_real_conid.sql` in Supabase SQL editor.
  2. `./bin/upside rebuild` on the VPS.
  3. Connect IB so the `ib` worker pool can drain. Initial backlog ~10 min IB. If IB stays connected overnight the whole sweep finishes in one window; if disconnected mid-way, the remaining jobs stay queued until next IB connection (per S0.3's pool gating).
- **Verification post-live-flip:**
  - Boot logs show `[conidResolutionProducer] starting, 24h cadence`.
  - First tick fires ~5 min after boot. Logs `[conidResolutionProducer] pending=N enqueued=N deduped=0 elapsed=Xs` showing how many universe rows were enqueued for resolution.
  - `bin/upside-psql -c "select worker_pool, status, count(*) from screener_jobs where action='resolve_conid' group by 1,2;"` shows the queue draining.
  - `bin/upside-psql -tAc "select round(100.0 * count(real_conid) / count(*), 1) from universe where filter_result='in';"` should reach **≥95%** within a few IB-connected hours. The ~5% unresolved are obscure types, delisted-since-Finnhub-pull, or genuine ambiguity.
  - Spot check: `bin/upside-psql -c "select symbol, conid as synthetic, real_conid from universe where symbol in ('REPL','MNTS','RGTI');"` shows real conids matching the ones in `watchlist_items` for MNTS + RGTI.
- **What's next:** S2 (trait scoring engine) joins `universe` ⨝ `intraday_stats` on `real_conid`, calls `ibHistory(real_conid, ...)` for catalyst_reversal Stage-2, etc. The whole screener track's IB-side work is now on the queue + properly conid-keyed.

### Batch S0.5 — Universe price + volume coverage (Polygon primary + Yahoo fallback) (2026-06-02)
- Owner: claude
- Started + Finished: 2026-06-02
- **What shipped:** daily-grain price + volume coverage for every Ring-1 IN universe ticker, via Polygon free-tier grouped-daily-bars (primary) + Yahoo v8/chart per-symbol (fallback). Built on top of S0.3's job queue — producer does direct Polygon work + enqueues per-gap Yahoo fallback jobs to the `finnhub` worker pool. Spec decision in `spec/signals/data-sources.md` → Universe coverage; integration design in the same file.
  - **Research (commit eb94f6d, doc-only, no separate claim per `feedback_doc_updates_no_batch`)**: tested Yahoo v8/chart (keyless, full OHLCV, per-symbol; works), Yahoo v8/spark batch (rejected — close-only, no volume), Yahoo v7/quote (rejected — crumb-cookie auth as of 2023). Polygon's grouped-daily-bars endpoint confirmed as ideal: one call → ALL US stocks' OHLCV, well under the 5/min free-tier cap. Alpaca + Twelve Data documented but not picked.
  - **Migration `022_universe_last_volume.sql`** — adds `last_volume bigint` to `universe`. Separate from `last_avg_volume` (the 30d median for catalyst_reversal Stage-1; updated by the weekly producer that lands as a follow-up).
  - **`server/src/services/universeQuote.ts`** — `polygonGroupedDaily(date)` (calls `/v2/aggs/grouped/locale/us/market/stocks/{date}` with `adjusted=true`, returns symbol→OHLCV map; throws on auth/network failure so the producer can log + skip) + `yahooChart(symbol)` (v8/chart, keyless via Mozilla UA, returns OHLCV from `meta` fields or null when missing). Defaults `open` to `previousClose` when Yahoo lacks `regularMarketOpen` directly.
  - **`server/src/cron/universeQuoteProducer.ts`** — 24h cadence, 5-min boot delay. Three steps per tick:
    1. Polygon grouped-daily for `yesterdayUtcDate()` → batched write of `(last_price, last_volume, computed_at)` to every universe row Polygon covered.
    2. Per-gap Yahoo fallback: `enqueue(jobKey, 'fallback_yahoo_quote', 'finnhub', {symbol, date})` for tickers Polygon's response missed.
    3. Drain prior-cycle `fallback_yahoo_quote` jobs: done rows deleted (worker already wrote OHLCV); failed rows go through producer-side retry (max 2 attempts) or `finalizeFailure`. Per `spec/job-queue.md` producer-owned retry policy.
  - **Worker action `fallback_yahoo_quote`** registered into `finnhubRegistry` from the producer file (keeps the action handler colocated with its producer's interface). Handler reads payload `{symbol, date}`, calls `yahooChart(symbol)`, writes OHLCV directly to the universe row by symbol. Throws on null Yahoo response so the framework marks the job failed.
  - **`server/src/env.ts`** — `polygonApiKey: optional('POLYGON_API_KEY')`. Producer skips cleanly when the key is unset (the cron logs "POLYGON_API_KEY not set — skipping" and returns).
  - **Boot wiring** in `server/src/index.ts` — `startUniverseQuoteProducer()` joins the existing cron set.
- **Vitest coverage** (in `server/src/services/universeQuote.test.ts`): 9 parser cases via mocked axios — Polygon happy path, empty results, HTTP error, Polygon-side NOT_AUTHORIZED, results without ticker field; Yahoo happy path, HTTP error, empty chart result, missing meta field. Pure parser surface; live HTTP exercised by the cron after deploy.
- **Manual prereqs for live-flip:**
  1. Sign up at https://polygon.io for the free tier — no credit card required. Generate an API key from the dashboard.
  2. Add `POLYGON_API_KEY=<key>` to **VPS** `.env` AND local `.env`.
  3. Apply migration `022_universe_last_volume.sql` in Supabase SQL editor.
  4. `./bin/upside rebuild` on the VPS.
- **Verification post-live-flip:**
  - Boot logs show `[universeQuoteProducer] starting, 24h cadence`.
  - First tick fires ~5 min after boot. Logs `[universeQuoteProducer] polygon hit=N/M gaps=G` showing how many of the M universe rows Polygon covered vs how many gapped to Yahoo. Healthy first run: hit≈M, gaps≈low double digits.
  - `bin/upside-psql -c "select count(*) from universe where filter_result='in' and last_price is not null and last_volume is not null;"` should return ≥ 90% of the `filter_result='in'` count within 24h.
  - `bin/upside-psql -c "select worker_pool, status, count(*) from screener_jobs where action='fallback_yahoo_quote' group by 1,2;"` shows fallback throughput; queue should drain to zero within the producer cycle.
- **Out of scope / follow-up:**
  - Weekly 30-day median refresh into `last_avg_volume` — separate small slice (~30 Polygon calls / week bootstrap, 7 calls/week steady-state). Spec'd in `spec/signals/data-sources.md` → Cadence per the caching plan; lands when S2's catalyst_reversal needs it.
  - Intraday volume coverage for `catalyst_reversal` Stage-1 — IB-snapshot path per spec; not this batch.
  - Real-time session updates for universe-only tickers — out of scope per spec; Screener tab (S4) renders the daily-refreshed price.

### Batch S0.3 — Async job queue (`screener_jobs`) (2026-06-02)
- Owner: claude
- Started + Finished: 2026-06-02
- **What shipped:** the screener-track infrastructure foundation — a Postgres-backed async job queue that decouples producers (cron schedulers) from workers (pure executors). Downstream screener batches (S0.5 / S1.5 / S2 / S3) and their IB-touching crons migrate onto this so IB-connection windows aren't wasted. Per `spec/job-queue.md`.
  - **Migration `021_screener_jobs.sql`** — `screener_jobs` table + the **partial unique index** on `job_key WHERE status IN ('queued','claimed')` (the dedup mechanism) + indexes for claim/drain/reaper. Two Postgres functions: `enqueue_job(...)` (INSERT … ON CONFLICT DO NOTHING; returns `'created' | 'deduped'`) and `claim_next_job(...)` (atomic `SELECT … FOR UPDATE SKIP LOCKED` + UPDATE-RETURNING; safe under concurrent worker claim). Both marked `security definer` + granted to `service_role`.
  - **`server/src/services/jobs/keys.ts`** — pure `makeKey(action, ...parts)` constructor. 5 vitest cases green; isolated in its own file so the test suite doesn't pull in supabase/env at module-load.
  - **`server/src/services/jobs/queue.ts`** — producer-facing API: `enqueue` (RPC), `drainDone`, `drainFailed`, `markRetry` (insert-fresh + delete-failed; race-safe via the partial index), `finalizeFailure`. Worker-facing API: `claimNext` (RPC), `markDone`, `markFailed` (never retry — producer's job).
  - **`server/src/services/jobs/actions.ts`** — typed `ActionRegistry` + three per-pool registries (`ibRegistry`, `finnhubRegistry`, `computeRegistry`). Ships two placeholder actions (`noop:ok` / `noop:fail`) for the framework smoke test. Downstream batches register real handlers into the relevant pool.
  - **`server/src/services/jobs/worker.ts`** — `createWorker({ pool, poolGateOk, idleMs, leaseSeconds, registry })` loop runner. Per-tick: `poolGateOk` → `claimNext` → execute via registry → `markDone` or `markFailed`. **Circuit breaker** per action — `notifyCritical` when ≥10 failures land within 5 min for a single action; suppresses re-fire until the window clears. Convenience factories `createIbWorker()` / `createFinnhubWorker()` / `createComputeWorker()` colocate pool gates: `ib` gates on `ibStatus().connected && .authenticated`; `finnhub` and `compute` are always open. Worker id format: `${pool}-${pid}-${hostname}`.
  - **`server/src/cron/jobsReaper.ts`** — 60s cadence, flips `status='claimed' AND lease_expires_at < now()` to `'failed' last_error='lease expired'` so the producer's drainFailed path picks up. Covers worker crash / hang / container-restart mid-claim.
  - **`server/src/cron/jobsRetention.ts`** — 24h cadence, 5-min boot delay. Deletes `done | failed` rows older than 7 days as a safety net.
  - **Boot wiring** in `server/src/index.ts` — three worker pools start + reaper + retention join the existing cron set.
- **Manual prereqs for live-flip:**
  1. Apply migration `021_screener_jobs.sql` in Supabase.
  2. `./bin/upside rebuild` on the VPS.
- **Verification post-live-flip:**
  - Boot logs show `[jobs/ib]`, `[jobs/finnhub]`, `[jobs/compute]` worker startup + `[jobsReaper]` + `[jobsRetention]` cadences.
  - Smoke (any future producer): enqueue `noop:ok` jobs, drain to zero via the `compute` worker within seconds. `bin/upside-psql -c "select worker_pool, status, count(*) from screener_jobs group by 1,2 order by 1,2;"` is the queue-depth-at-a-glance query.
  - Dedup: two rapid enqueues of identical key → second returns `'deduped'`, only one queued row exists.
  - Crash safety: kill worker mid-claim → reaper transitions to `failed` after lease expiry (default 5 min).
- **What this batch does NOT do** (per `spec/job-queue.md` → "What this layer does NOT do"): no DAGs, no lease-renewal heartbeats, no realtime dashboard, no external queue infra. Downstream batches' producers do their own retry policy + Stage1→Stage2 dependency handling in producer logic.
- **What's next:** downstream batches (S0.5, S1.5, S2, S3) now register their real action handlers via `ibRegistry` / `finnhubRegistry` / `computeRegistry` and turn their crons into producer cycles.

### Batch S1 — Stock universe + Ring 1 nightly cron (2026-05-31)
- Owner: claude
- Started + Finished: 2026-05-31
- **What shipped:** the screener-track foundation — a `universe` table that the nightly cron maintains. S2/S3/S4 all read from this.
  - **Migration `019_universe.sql`** — `universe(conid PK, symbol, type, mic, last_filter_pass, filter_result CHECK in {in, out_price, out_cap, out_volume, no_data}, last_price, last_market_cap_m, last_avg_volume, computed_at)`. Two indexes (`filter_result`, `symbol`). Service-role-only writes. No Realtime publication (high churn, no FE consumer — the Screener tab will read `trait_scores` per S2).
  - **`server/src/services/screener/universeFilter.ts`** — pure Ring-1 evaluator + pre-DB sieve. Surfaces the full diagnostic enum (including `out_type` / `out_mic` for testability) even though only the price/cap branches are DB-recorded. **24 vitest cases all green** — every enum branch + the pre-sieve + ordering edge cases.
  - **`server/src/cron/universeCron.ts`** — 24h cadence, 5-min boot delay (mirrors `intradayStatsCron`'s pattern). Steps per tick: `getSymbolList('US')` → preFilterByTypeAndMic (sieves ~30.5k → ~5.3k) → per-symbol `getQuote` + `getProfile2` in parallel via `finnhubQueue` (queue handles the 50/min budget natively) → `filterRing1` → batched upserts (100 rows/batch) → retention sweep (delete rows older than 30d). Progress log every 500 symbols. `mode: 'nightly' | 'premarket'` arg accepted; premarket is a stub (volume-gap promotion lands in S2 alongside the daily-bar pipeline).
  - **`server/src/services/finnhub.ts`** extended with `getSymbolList(exchange='US')` and `getProfile2(symbol)` (both queued through the existing infrastructure with categories `symbol` + `profile`).
  - **`server/scripts/runUniverseCron.ts`** + `npm run cron:universe` — one-shot kick bypassing the 5-min boot delay; useful for manual sweep after migration applies.
  - **Boot wiring** in `server/src/index.ts` — `startUniverseCron()` joins the existing cron set.
  - **Synthetic conid keying** — Finnhub's `/stock/symbol` payload doesn't carry IBKR conids (it's figi/cusip-keyed), so `universe.conid` uses a stable negative-bigint FNV-1a hash of `mic|symbol` so the table has a primary key and re-runs are idempotent. Real conids back-fill via a one-shot migration when IB secdef resolution is wired.
- **Manual prereqs for live-flip** (per `feedback_infra_handson`):
  1. Apply migration `019_universe.sql` in Supabase.
  2. `./bin/upside rebuild` on the VPS.
  3. (Optional) Trigger a one-shot sweep — exec into the api container and run `npm run cron:universe`; otherwise the first scheduled sweep runs 5 min after boot, takes ~100 min wall-clock at 60-cpm Finnhub free tier.
- **Verification** (after live-flip): `bin/upside-psql -tAc "select count(*) from universe where filter_result='in';"` returns a number within the **2,728–3,373** CI from the 2026-05-30 scoping sample (point ~3,051). `bin/upside-psql -c "select filter_result, count(*) from universe group by filter_result;"` shows the breakdown of why other ~2,000 symbols dropped out (mostly `out_price` + `out_cap`).
- **Commit:** (this batch).
- **What's next:** Batch S2 (trait scoring engine) plugs into the `(filter_result='in')` rows this cron produces. Per the dependency chain, S2 → S3 → S4 follow.

---

**Older completed batches archived in [`CLAIMS_DONE.md`](CLAIMS_DONE.md)** — Polish slices, Batch C first slice, Tooling slice, Batch B, A1/A2/A+, 14a/14c/14e/14f/14.5, 13.x, 12, 11, 10, 8, 9, 7.5/7, 6, 5, 4, 3, 2, 1, plus the 2026-05-24 Settings + Discord-observability slices. Moved 2026-06-03 under Batch M1 to keep this file under the Read-tool 25k single-call cap.

