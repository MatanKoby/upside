# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

### Batch X2 — Watchlist virtual lists (Intraday / Swing)
- Owner: claude
- Started: 2026-06-06 05:06

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

### Batch X1 — Dip-bounce track (curated list + two-scorer alert + forward-tracking) (2026-06-05)
- Owner: claude
- Started: 2026-06-05 18:27 · Finished: 2026-06-05 19:06
- Commit: ef300a2
- **What shipped:** the 2026-06-03 dip-bounce design as one batch — the curated alert pool, two dip-bounce scorers firing to two Discord channels, and the durable forward-tracking backbone.
  - **Migration `028_dip_bounce.sql`** — `curated_list` (conid, asof_date, rank, score, avg vol, daily_atr_pct), `signal_fires` (generic across signal kinds — `intraday_dip_bounce`/`swing_dip_bounce`/`band_touch_*`; components jsonb), `signal_outcomes` (+30m/+2h/+1d/+3d snapshots, FK cascade), and the **`signal_hit_rate_30d` view** (intraday reads +2h vs +1%, swing reads +3d vs +5%). Realtime on `curated_list` only; service-role write + authenticated select (view resolves security-invoker).
  - **`config/curatedList.ts`** (TARGET_SIZE 250, MIN_AVG_VOLUME 1M, MIN_DAILY_ATR_PCT 1.5) + **`config/dipBounceScorer.ts`** (both scorers' named weights/thresholds/cooldowns + OUTCOME_OFFSETS).
  - **`services/curatedList/buildCuratedList.ts`** (pure: volume + daily-ATR gates → sort by trait score → cap) + 5 vitest.
  - **`services/dipBounce/intradayScorer.ts`** (pure table composition; deep-veto guard on IN_TYPICAL_BAND) + 7 vitest. **`swingScorer.ts`** (technicals daily RSI/ATR/trend + band_state + entry_zones; near-confluent-zone within 1·ATR) + 7 vitest.
  - **`services/dipBounce/computeSet.ts`** — `loadComputeSet` = curated ∪ active-watchlist ∪ held (shared by the dip cron + the band engine).
  - **`services/dipBounce/dipBounceCron.ts`** — 60s cadence (regular + AH); batch table loads, per-session in-memory daily-pack cache (IB) for the swing scorer, per-(conid,kind) cooldown read off `signal_fires`, fires → `signal_fires` row + Discord.
  - **`cron/curatedListCron.ts`** — IB-gated, 12h cadence; trait_scores ⨝ universe (volume gate) → daily-bar ATR% probe in score order (bounded) → `buildCuratedList` → upsert + stale-drop + 7-day retention.
  - **`cron/signalOutcomesCron.ts`** — 5-min; fills each due offset's price snapshot + return_pct (generic over signal_kind).
  - **`notify.ts`** — `notifyIntradayDipBounce` + `notifySwingDipBounce` (two channels). **`env.ts` + `.env.example`** — `DISCORD_WEBHOOK_INTRADAY_SUGGESTIONS` / `_SWING_SUGGESTIONS`.
  - **Compute-set widening (deliverable 14)** — `bandEngineCron` now walks `loadComputeSet` (curated ∪ active-watchlist ∪ held), not curated-only; `loadCuratedList`/`loadHeldConids` removed in favor of the shared helper.
  - **`scripts/dip-bounce-backtest.mjs`** (throwaway) — swing fire-rate sanity check.
  - **Boot wiring** — `startCuratedListCron` + `startDipBounceCron` + `startSignalOutcomesCron` in `index.ts`.
- **Implementation forks (deviations from the batch sketch):**
  - **Separate `dipBounceCron` (not an `upsertQuote` hook)** — per deliverable 8's "keep the poll-cycle path clean" guidance; the user has been bitten by alert checks bloating the poll cycle. 60s cadence approximates the ~10s poll intent without touching the hot write path.
  - **Swing daily indicators via an IB daily-bar pull + technicals.ts** (per deliverable 7), cached per session in memory — the spec's "pure table reads, no IB" cadence note holds for the **intraday** scorer (which keeps firing on Finnhub quotes when IB is off); swing only scores names whose pack is cached (IB up ≥ once this session). No daily-indicator table was added.
  - **Confluence derived from `entry_zones.reasoning`** (`/confluence/i`) — the engine writes "confluence — …" when ≥2 sources cluster; no boolean column exists.
  - **curatedListCron is 12h-from-boot, not wall-clock-pinned** to 09:00/15:30 IDT, and **full-rebuilds** on each run (premarket isn't incremental) — matches the codebase's interval-from-boot cron infrastructure; "rebuild whenever IB is up, a couple times a day."
  - **Date keys:** `curated_list`/`trait_scores` keyed by UTC date (matching how trait_scores is written/read elsewhere); `band_state` by ET session date. computeSet/dipBounceCron/bandEngineCron all read each table with its own convention.
- **Verification:** `pnpm typecheck` clean (+ scripts tsconfig); `vitest run` **169/169** (19 new: 5 buildCuratedList + 7 intraday + 7 swing). Backtest ran: crude swing proxy ~0.2 fires/day across a 10-name sample (~5/day scaled to 250); the stricter live gates (confluence-required near-zone + vol-regime veto + band_state) pull it toward the 1-3/day target. v1 thresholds kept — real calibration comes from `signal_outcomes` after a month (per spec).
- **Manual prereqs for live-flip:**
  1. **Apply `028_dip_bounce.sql`** in the Supabase SQL editor.
  2. Create Discord channels `#upside-intraday-suggestions` + `#upside-swing-suggestions`, set `DISCORD_WEBHOOK_INTRADAY_SUGGESTIONS` + `DISCORD_WEBHOOK_SWING_SUGGESTIONS` in VPS `.env` (without them, fires still log to stdout + write `signal_fires`, just no Discord ping).
  3. `./bin/upside rebuild` on the VPS.
  4. IB connected (curatedListCron + swing daily-pack + bandEngine all need daily bars).
- **Verification post-live-flip:**
  - Boot logs show `[curatedListCron]`, `[dipBounceCron]`, `[signalOutcomesCron]` starting.
  - `bin/upside-psql -c "select count(*) from curated_list where asof_date = (now() at time zone 'utc')::date;"` returns `[1, 250]` after the first IB-up `curatedListCron` tick.
  - During a session, at least one fire per channel; `bin/upside-psql -c "select signal_kind, count(*) from signal_fires where fire_ts > now() - interval '1 day' group by 1;"`; `signal_outcomes` accumulate at the four offsets; `select * from signal_hit_rate_30d;` aggregates once ≥1wk of data exists.
  - Cooldown: same ticker firing twice within 4h (intraday) / 24h (swing) → second skipped.
- **Out of scope / follow-up:**
  - **X2** (Watchlist virtual lists) renders these as two ranked leaderboards + the rolling hit-rate column; X1's compute-set widening + union data feed it. Until X2, the data is `bin/upside-psql`-queryable.
  - Porting band-touch + marker fires onto `signal_fires` (queued under Batch C remainder).
  - A persisted daily-indicator cache (RSI/ATR) would make the swing scorer fully table-only + IB-independent — deferred; not needed for v1.
- **What's next:** **Batch X2** (Watchlist virtual lists — Intraday/Swing leaderboards, retires the Screener tab). Depends on X1 (done) + soft-dep R2 (done — shared `DangerBadge`).

### Batch R2 — Risk-flags FE (2026-06-05)
- Owner: claude
- Started: 2026-06-05 15:17 · Finished: 2026-06-05 18:06
- Commit: 77c1a89
- **What shipped:** the user-facing surface for R1's risk flags — danger badge, TickerDetail section, CRITICAL pre-analysis gate, Settings threshold controls — plus the first `user_preferences` FE→BE write path. Pure FE consumer of R1's `risk_flags` table; one new BE route (no new migration, no schema/cron/signal-engine change).
  - **`utils/riskFlags.ts`** (new) — pure presentation layer: `RiskFlagRow`/`ActiveFlag` types, priority order, `dominantFlag`, `flagBadgeLabel`, `flagName`, `flagExplanation` (plain-language, payload-filled), `flagThreshold`, `orderedFlags`. All the copy lives here so components stay dumb.
  - **`hooks/useRiskFlags.ts`** (new) — `useRiskFlags(conid)` (single-row, latest asof_date, Realtime) for TickerDetail + gate; `useAllRiskFlags()` (conid→row map, one Realtime sub, mirrors `useAllSignals`) for the list badges. Both reduce to latest-asof-per-conid and drop empty rows.
  - **`components/primitives/DangerBadge.tsx`** (new) — the shared pill (red CRITICAL / amber WARNING, ⚠ icon + dominant-flag label + "+N", `compact` variant for the watchlist chip). Renders **first** in the Portfolio card's signal+badge row, separate from the signal pill; also lands in the Watchlist row chip cluster. X2's soft-dep on a shared `TickerCard` danger badge is satisfied by this primitive.
  - **`components/TickerDetail/RiskFlagsSection.tsx`** (new) — section body (one row per flag: name · explanation · threshold · `since`) + `RiskFlagsAccessory` (severity+count header chip). Wired into TickerDetail as a `CollapsibleSection`, `defaultOpen` when CRITICAL, rendered above the Signal section per `ticker-detail.md` ordering.
  - **`components/TickerDetail/PreAnalysisGateModal.tsx`** (new) — DANGER modal fronting Analyze/Refine on CRITICAL tickers. SignalSection gates the primary Analyze **and** the soft-block "re-analyze anyway" path (one confirm per mount) *before* the existing two-step friction; WARNING never gates. The BE `signalQuality ≤ 35` clamp (R1) is the backstop when the user proceeds.
  - **Settings → Risk flags** — `RiskFlagsSettingsSection` (six tunables: surge X%/N, vol Y×, RSI Z, near-52w W%, micro-cap $C edited in $M, earnings D days) + Save/Reset, backed by **`hooks/useRiskFlagConfig.ts`** (new) over the new route.
  - **`server/src/routes/user.ts`** (new) + `index.ts` mount — `GET/PUT /api/user/preferences`. GET returns the resolved effective config + defaults + `isCustom`; PUT validates each field against per-field bounds, merges over current (partial PUT = partial override), upserts `user_preferences` via service-role (onConflict `user_id`), reuses `resolveRiskFlagConfig`. This is the **first FE write into `user_preferences`** — RLS has owner-read/update but no INSERT policy, so the service-role BE path is required (matches `settings.md`).
  - **conid threading** — `Position.conid` + `TickerDetailData.conid` added; `usePositions` + `useTickerDetail` (both held + watchlist branches) populate them so the conid-keyed `risk_flags` rows join to the symbol-keyed FE.
- **Implementation forks (deviations from the batch sketch):**
  - **Added the BE prefs route** (the batch listed it implicitly via Settings deliverable 5; R1's note deferred the write to R2). It's the first `user_preferences` write path, so it ships here with bounds-validation rather than letting the client write Supabase directly (no INSERT RLS policy exists).
  - **`useAllRiskFlags()`** added alongside the spec's single-row `useRiskFlags(conid)` — the Portfolio/Watchlist lists need one shared subscription, not one per card.
  - **Latest-asof-per-conid** (not strict `asof_date = today`) so a flag raised on a prior IB-connected day still shows until the engine clears it.
- **Verification:** server `pnpm typecheck` clean (incl. scripts tsconfig); client `pnpm build` (tsc --noEmit + vite) clean; server `vitest run` **150/150** (no FE test runner — tsc + build is the FE gate, per prior FE batches). UI behavior is user-driven (per `feedback_user_drives_ui_testing`).
- **Manual prereqs for live-flip:**
  1. R1's `027_risk_flags.sql` applied (same migration — no new one for R2).
  2. `./bin/upside rebuild` on the VPS so `/api/user/preferences` is served.
  3. IB connected so `riskFlagsCron` populates rows (otherwise badges/sections won't appear — there's nothing flagged yet).
- **Verification post-live-flip:**
  - A flagged held/watched name shows the danger badge on its card at a glance; color matches severity.
  - Opening it → Risk-flags section lists each active flag (expanded when CRITICAL); absent on a clean ticker.
  - Analyze on a CRITICAL ticker opens the gate modal before the two-step friction; WARNING does not gate.
  - Settings → Risk flags: edit a threshold → Save persists; reopen reflects it; the next nightly/on-demand pass uses it.
- **What's next:** **Batch X1** (dip-bounce track) is the top remaining pick per the BUILD_QUEUE pointer. **Batch X2** (Watchlist virtual lists) reuses this `DangerBadge` primitive — its R2 soft-dep is now satisfied.

### Batch R1 — Risk-flags engine (data + LLM integration) (2026-06-05)
- Owner: claude
- Started: 2026-06-05 14:20 · Finished: 2026-06-05 18:05
- Commit: 84ea4d1
- **What shipped:** the daily-grain danger-flag engine per `spec/signals/risk-flags.md` — six v1 flags + WARNING/CRITICAL tiers + LLM integration. Data/signal layer only; the FE badge/section/gate is Batch R2.
  - **Migration `027_risk_flags.sql`** — `risk_flags(conid, asof_date, flags jsonb, severity, computed_at)` PK `(conid, asof_date)`; a row exists only when ≥1 flag is active (absence = clean). Realtime + service-role-write/authenticated-read grants (instrument-keyed, band_state pattern). Adds nullable `user_preferences.risk_flag_config jsonb` (null = seed defaults).
  - **`config/riskFlags.ts`** — `RISK_FLAG_DEFAULTS` (surge 25%/5d, vol 3×, RSI 78, near-52w 5%, micro-cap $500M, earnings 5d), `resolveRiskFlagConfig` (partial-override merge), `severityFor` (CRITICAL = price_surge ∧ corroborating, or micro_cap escalated by one corroborating flag), `CRITICAL_QUALITY_CAP = 35`.
  - **`services/riskFlags/`** — `computeRiskFlags.ts` (pure: inputs → `RiskFlagRow | null`, since-inheritance), `inputs.ts` (surgePct / relVol / marketCap / earningsDays assemblers from bars + Finnhub), `engine.ts` (`loadPrevSince` + persist/delete + `evaluateAndStore` + `riskFlagAsofDate`). 17 vitest fixtures.
  - **`cron/riskFlagsCron.ts`** — 60min IB-gated pass over held + active-watchlist conids; upserts flagged rows, deletes cleared ones.
  - **`signalEngine` wiring** — on-demand top-up at Analyze: reuses the daily bars + earnings already pulled, adds one `basicFinancials` call for market cap, persists the row, sets `contextualTriggers.riskFlags`, and clamps `signalQuality ≤ 35` post-validation when severity is CRITICAL. **`llm.ts`** — RISK FLAGS prompt block (pump-downgrade instruction) + the trigger type. **`index.ts`** — boot wiring.
  - **`scripts/risk-flags-calibrate.mjs`** (throwaway, not maintained) — retro-validated the seed defaults: SPCE/RGTI/MNTS fire (max trailing-5d surge 132/60/236%, surge-days 12/28/26) while AAPL/MSFT/KO stay at 0 surge-days (≤14%). Defaults kept.
- **Implementation forks (deviations from the batch sketch):**
  - **No `PUT /api/user/preferences` route** — none exists today, and the threshold-tunables UI is R2 (Settings). R1 only *reads* `risk_flag_config` (defaults when null); the write lands with R2's Settings controls.
  - Cron cadence is 60min IB-gated rather than a single nightly tick — inputs are daily-grain, so the cadence is only about catching whatever window IB happens to be connected in; this tracks the on-demand IB sessions better than a fixed nightly time.
- **Verification:** server `pnpm typecheck` clean (incl. scripts tsconfig); `pnpm exec vitest run` **150/150** (17 new riskFlags fixtures). Calibration script run locally — clean pump-vs-clean separation.
- **Manual prereqs for live-flip:**
  1. Apply `027_risk_flags.sql` in the Supabase SQL editor.
  2. `./bin/upside rebuild` on the VPS.
  3. Connect IB so the cron can pull daily bars (IB-gated, like `intradayStatsCron`).
- **Verification post-live-flip:**
  - Boot logs show `[riskFlagsCron] starting, 60min cadence (IB-gated)`.
  - With IB connected, after a tick: `bin/upside-psql -c "select conid, severity, jsonb_array_length(flags) from risk_flags where asof_date = current_date order by severity;"` shows rows for any held/watched name meeting a threshold; clean names have no row.
  - Analyze a pumped held/watchlist name → persisted `signal_quality ≤ 35` (CRITICAL clamp) regardless of model output; the analysis prompt carried the RISK FLAGS line.
- **What's next:** **Batch R2** (FE) renders these — danger badge on the card, Risk-flags section + CRITICAL pre-analysis gate in TickerDetail, Settings threshold controls (which adds the `risk_flag_config` write). R2 is the visual test surface.

### Batch S3 — Improved entry engine: adaptive band layers (2026-06-03)
- Owner: claude
- Started: 2026-06-03 06:32 · Finished: 2026-06-03 07:06
- Commit: 009e516
- **What shipped:** the three adaptive band layers from `signals/band-engine.md`, stacked on top of the static `intraday_stats` baseline.
  - **Migration 026_band_state.sql** — new `band_state(conid, session_date, anchors jsonb, current_low_band, current_high_band, session_regime, vol_scalar, vol_regime_shift, band_touch_last_fired_at jsonb, updated_at)` PK `(conid, session_date)`. Realtime enabled; service-role write, authenticated read.
  - **Layer 1 — `sessionRegime.ts`** (pure): gap + first-15-min direction + premkt-vol-ratio → `mean_reversion | bullish_trend | bearish_trend | mixed`. 10 vitest fixtures covering all four labels + boundaries + null premkt fallback.
  - **Layer 2 — `volScalar.ts`** (pure): `ATR(last 12 5min bars) / baseline_atr → scalar (0.7 / 1.0 / 1.5) + annotation (calm_day / null / high_vol_today)`. Includes the MNTS 2026-05-30 validation fixture (2.6× vol → 1.5× wider band).
  - **Layer 3 — `walkingState.ts`** (pure): state machine with `anchor_low / anchor_high / running_max / running_min / leg_direction / anchors[]`. Re-anchors on observed reversal from running extremum (threshold = `0.5 × intraday_ATR`). `leg_direction` added as explicit state (spec implied it but didn't name it) to prevent same-side anchor re-firing. 15 fixtures incl. seed phase, direction-tracking, REPL-style 5-leg ladder, publication math, vol_scalar widening.
  - **`volRegimeShift.ts`** (pure): daily flag — last 5 sessions' ATR > 2× prior 30d ATR. 5 fixtures.
  - **`bandEngineCron.ts`** — 5-min cadence during regular session + AH (09:30–20:00 ET). Loads today's `intraday_range_trader` curated list, IB-pulls `'2m' '5mins'` bars per conid, stacks Layer 1 (on first tick after 09:45 ET) + Layer 2 + Layer 3, persists `band_state`, fires band-touch Discord pings with 4h per-(conid, band_kind) cooldown via `band_touch_last_fired_at` jsonb.
  - **`notify.ts`** — added `notifyBandTouchLow` (→ `DISCORD_WEBHOOK_DIP_BUYS`, existing channel, for non-held curated) + `notifyBandTouchHigh` (→ new `DISCORD_WEBHOOK_SELL_ZONES`, for held positions).
  - **`env.ts` + `.env.example`** — new `DISCORD_WEBHOOK_SELL_ZONES` slot.
  - **Wiring** — `startBandEngineCron()` added to `index.ts` after the trait producers + retention block.
- **v1 simplifications persisted to spec (`spec: 009e516`):**
  - Baseline ATR approximated as `today_open × intraday_low_pct_p50 / 100` — `intraday_stats` carries no `atr_30d_5min` column. Track-10 sharpening = add the column + compute in `intradayStatsCron`.
  - Symmetric fade-pct (one `intraday_low_pct_p50` used for both up- and down-leg) — schema carries no `leg_up_fade_pct_p50` / `leg_down_fade_pct_p50` split. Track-10 sharpening = extend `computeIntradayStats` to bucket per-leg fade.
  - Both noted as `Fade-pct + baseline-ATR sourcing (v1 simplification)` in `signals/band-engine.md` + as a follow-up in `roadmap.md` Track 10. Spec also fixes the **15:45 IDT → 16:45 IDT** classifier-timestamp typo + adds `leg_direction` to the persisted-state section.
- **Manual prereqs for live-flip:**
  - Create `#upside-sell-zones` Discord channel + incoming webhook → set `DISCORD_WEBHOOK_SELL_ZONES` in VPS `.env`. (Optional — without it, high-band touches still log to stdout, just no Discord ping.)
  - Apply migration `026_band_state.sql` (`supabase migration up` on prod or via the migration GUI).
- **Verification:**
  - `pnpm typecheck` clean; `pnpm exec vitest run` 133/133 (39 new band-engine fixtures + 94 existing).
  - During regular session: `bin/upside-psql -c "select conid, session_regime, vol_scalar, jsonb_array_length(anchors) from band_state where session_date=current_date order by jsonb_array_length(anchors) desc limit 10;"` should show curated tickers with regime labels + anchor counts growing through the session.
  - Band-touch Discord pings fire on first cross + are suppressed within 4h.
  - When `vol_regime_shift = true`, the published low band is visibly wider than the static `intraday_stats` band would have been.
- **Follow-ups deferred (Track-10):**
  - `intraday_stats.atr_30d_5min` column + nightly computation (replaces the price-space-from-p50 baseline proxy).
  - `intraday_stats.leg_up_fade_pct_p50` + `leg_down_fade_pct_p50` columns + per-leg fade computation (replaces the symmetric proxy).
  - Both wait on enough live band-engine sessions to compare predicted vs. realized leg sizes — data-driven sharpening, not blind extension.
- **Known caveat:** `bandEngineCron` is IB-gated like `intradayStatsCron` — when IB is disconnected the tick is a no-op (curated list still loads but bars pull returns null + per-conid loop fails fast). User's on-demand IB session covers regular-hours coverage; AH coverage is only when the user keeps IB connected past close.

### Batch M1 — Agent context efficiency (measurement + structural slim-down) (2026-06-03)
- Owner: claude
- Started: 2026-06-03 05:46 · Finished: 2026-06-03 06:13
- Commit: 63b0af0
- **What shipped:** five slices in one commit, all aimed at cutting agent context burn in long sessions:
  - **Slice A — measurement.** `.claude/hooks/read-counter.sh` (PreToolUse on the Read tool) appends `<utc-iso>\t<file>\t<bytes>\t<session-id>` to gitignored `.claude-stats/file-reads.log` on every Read call. Non-blocking, silent, resilient to missing dir. `bin/upside-readstats [N]` prints the top-N most-read files lifetime + last 7d, with avg-bytes + distinct sessions, plus a totals footer. Both registered in `.claude/settings.local.json` (Read-hook entry + `Bash(bin/upside-readstats:*)` allowlist). `.claude-stats/` added to `.gitignore`. Smoke-tested with synthetic hook input — TSV row appended, `upside-readstats 5` rendered cleanly. The hook itself starts emitting from the next session start (Claude Code loads hooks at boot).
  - **Slice B — content splits.** `BUILD_QUEUE_DONE.md` (new, 72 lines) holds the one-paragraph summaries that used to live in `BUILD_QUEUE.md`'s "## Completed batches" section. `CLAIMS_DONE.md` (new, 300 lines) holds the older completed entries (Polish slices, A1/A2/A+, Batch B/C first slice, Tooling slice, 14a/c/e/f/14.5, 13.x, 12, 11, 10, 8, 9, 7.5/7, 6, 5, 4, 3, 2, 1, plus the 2026-05-24 Settings + Discord-observability slices). Active `CLAIMS.md` keeps In progress + Known issues + the five most recent (S2 / S1.5 / S0.5 / S0.3 / S1) + a cross-link footer; trimmed from 464 → 179 lines. Active `BUILD_QUEUE.md` now points at `BUILD_QUEUE_DONE.md` for history and carries only the Un-done section + pick-order pointer.
  - **Slice C — procedure extraction.** Three new skills under `.claude/skills/`: `claim-batch` (pull, eligibility, dependency, parallelism, `CLAIMS.md` entry, `meta: claim`, push-race recovery, mid-batch handoff, stale-claim recovery), `finish-batch` (final SHA capture, move-to-Completed, `meta: complete`, `/compact` reminder), `spec-edit` (concern-matching via per-folder README, cross-reference rule, archive rule, propagation to `BUILD_QUEUE.md`, persisting design decisions). All three appeared in the available-skills system reminder live during this session — verifying the harness picks them up automatically.
  - **Slice D — hierarchical spec index.** `spec/signals/README.md` (new, 21 lines) indexes the 9 signal files; `spec/screens/README.md` (new, 19 lines) indexes the 7 screen files. `spec/README.md` slimmed from per-file rows for both sub-folders to root-files + pointer-to-sub-folder-READMEs; 88 → 42 lines.
  - **Slice E — AGENTS.md slim-down.** Spec-layout table → one-line pointer to `spec/README.md`. Claim / push-race / mid-batch handoff / stale-claim recovery / finish / spec-edit-and-design-decisions → each compressed to a 2-3 line policy statement + a pointer to the relevant skill. Force-push prohibition stays inline (it's policy, not procedure). Commit-message convention table, file ownership, ideation handoff, branch model, what-does-NOT-belong → unchanged. AGENTS.md down from 231 → 130 lines. `CLAUDE.md` and `BUILD_QUEUE.md` stale "6 domain files + archive" references both updated.
- **Verification:**
  - `git diff --stat` shows 15 files / +748 / -510, no `server/` or `client/` touches (slice D + E only).
  - All three new skills (`claim-batch`, `finish-batch`, `spec-edit`) live in the available-skills system reminder.
  - `CLAIMS.md` (~8.3k tokens), `AGENTS.md` (~2.2k tokens) both fit under the Read-tool 25k single-call cap.
  - `BUILD_QUEUE.md` post-split is still over the 25k cap because the user-owned Un-done section still carries the full S0.3-S2 batch bodies plus the post-MVP polish/PWA batches. Pruning those is the user's call (BUILD_QUEUE.md is user-owned) — or a later data-driven M2 slice.
  - `bin/upside-readstats` smoke-rendered the top-N table from synthetic input.
- **Out of scope (deferred to M2, data-driven, after ~1 week of read-counter stats):** content-spec splits (signals/* / schema.md / roadmap.md); code-file splits; auto-summarization of archive files; hooks on Write/Edit/Bash.
- **What's next:** S3 (band engine — adaptive layers on top of the static intraday-stats band) remains the top un-done pick per the BUILD_QUEUE pointer. M2 surfaces itself once read-counter data accumulates.

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

