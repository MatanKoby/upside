# Batch Claims — Archive

Older completed batch entries, archived 2026-06-03 under Batch M1 to keep the active `CLAIMS.md` under the Read-tool 25k single-call cap. Recent completed batches (the five most recent at archive time — S2 / S1.5 / S0.5 / S0.3 / S1) stay in `CLAIMS.md`. Newly-finished batches are recorded in `CLAIMS.md`; periodically the older ones move here.

This is reference-only. No claim or finish protocol writes here.

---

## Completed (archived)

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
  - **`notify.ts`** — `notifyIntradayDipBounce` + `notifySwingDipBounce` (two channels). **`env.ts` + `.env.example`** — `DISCORD_WEBHOOK_SUGGESTIONS_INTRADAY` / `_SWING`.
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
  2. Create Discord channels `#upside-intraday-suggestions` + `#upside-swing-suggestions`, set `DISCORD_WEBHOOK_SUGGESTIONS_INTRADAY` + `DISCORD_WEBHOOK_SUGGESTIONS_SWING` in VPS `.env` (without them, fires still log to stdout + write `signal_fires`, just no Discord ping).
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

### Polish slice — PriceFlicker animation + loading-state fix + ATR/Range/Scalpable on TickerDetail (2026-05-30 → 2026-05-31)
- Owner: claude
- Started: 2026-05-30 · Finished: 2026-05-31
- Commits: c63f95c (animation wired in Watchlist + PositionCard + TickerDetail) → 05a0503 (TickerDetailShell + Watchlist header-stays-during-loading) → f93cf7a (ATR/Range today/Scalpable sessions on MarketStats).
- **What shipped:** three FE polish slices bundled — same theme: make every ticker price surface honest about what's happening.
  - **PriceFlicker** drops into every ticker price surface; 200ms color flash + directional arrow (▲/▼) on any change; double flash on bigger moves scaled to today's realized vol (floor 0.5%, otherwise 0.4× |today_change_pct|); layout never shifts (arrow absolutely-positioned). Uses project `--gain-rgb` / `--loss-rgb` so dark mode behaves.
  - **Loading/error/not-held states on TickerDetail** extract a `TickerDetailShell` that keeps the back-button + symbol-title header geometry stable while the body shows the state message. Watchlist drops its early-return guard on `isLoading` so the title/glossary/settings header always renders (body shows "Loading…" while data resolves). No more "whole screen says coming-soon" pattern.
  - **ATR(14d) + Range today + Scalpable sessions** added to Market Stats. BE pulls daily IB bars (`ibHistory(conid, '1y', '1d')`) on the snapshot route, computes via newly-exported `technicals.atr`, caches 6h alongside fundamentals. FE format "5.2% · $0.42" + "27/30 (90%)". Headline volatility cell replaces beta in the prime grid position; beta stays in the grid but no longer headlined (it's correlation-to-market, wrong axis for intraday scalping). Range Today computed FE-side from existing dayHigh/dayLow/open — no extra call.
- **Live verification:** Animation auto-visible on next FE Realtime quote tick post-Vercel-deploy; loading-state fix only visible during the brief skeleton window on screen load; ATR/Range/Scalpable cells render after `./bin/upside rebuild` on the VPS (snapshot endpoint needs the new fields). Server + client typecheck clean throughout.

### Screener Slice 1 — scoping artifacts (universe sample + retroactive band validation + animation prototype) (2026-05-30)
- Owner: claude
- Started + Finished: 2026-05-30
- Commit: a31264d (artifacts) + 7c14f33 (spec split, doc-only — no separate CLAIMS entry per `feedback_doc_updates_no_batch`)
- **What shipped:** pure exploration + design artifacts, no production code (foreground after the subagent-on-worktree attempt failed earlier — see [[feedback_no_subagents]]):
  - `scripts/universe-sample.mjs` — Finnhub `/stock/symbol` pull (30,538 US symbols) → type+MIC filter (→ 5,307 pool) → 250-symbol random sample with `/quote` + `/stock/profile2` → applies $1-100 price + $150M cap. First run reported **Wilson 95% CI 2,728 – 3,373** survivors (point ~3,051), distribution roughly even across price + cap bands with small/mid caps dominant.
  - `scripts/validate-bands.mjs` — retroactive band validation against user's actual 2026-05-29 trades. **RGTI**: 60d p50 dip 3.97%, actual 7.60%, user's $25.00 buy INSIDE p25–p75 envelope ($0.40 from p50 of $25.40). **MNTS**: 60d p50 dip 6.46%, actual **16.67%**, user's three buys ALL OUTSIDE envelope — exactly the `vol_regime_shift` case the adaptive band-engine layers are designed for. RGTI proves the static math; MNTS proves the adaptive layers are necessary, not optional.
  - `client/src/components/common/PriceFlicker.tsx` + `scripts/anim-integration.md` — drop-in price-change animation component + integration sketch (wired into production by the polish slice above).
  - **Spec split** (7c14f33, doc-only): `signals/screener-universe.md` leaned to 161 lines; new `signals/band-engine.md` (215 lines, the three adaptive layers); new `screens/screener.md` (130 lines, the FE tab); screener tables added to `schema.md` (universe, trait_scores, band_state); screener flows added to `flows.md` (Universe Sweep, Pre-mkt Refresh, Band Walk, Band-Touch Notification); Track 10 deferred items in `roadmap.md` (RSS firehose, mid-day discovery, sell-side mirror, AH-bands, IBKR push, auto-marker, auto-truncating-lookback) — each with an empirical revisit trigger; `data-sources.md` expanded to mention SEC EDGAR / FDA RSS / PR wires / Nasdaq Trader (planned for the RSS firehose phase).
- **What this unblocks:** Batches S1–S4 (screener-track Slice 1 implementation) have their design + empirical justification + reusable component artifacts ready.

### Batch C — first slice landed: noise floor on entry-zone Discord alerts (2026-05-30)
- Owner: claude
- First slice finished: 2026-05-30
- Commit: f750aa2
- **What shipped:** three filters added to `checkEntryZonesForConid`, driven by the 2026-05-30 dip-buys channel audit:
  - **Confidence floor** (`MIN_CONFIDENCE_PCT = 60`) drops zones below 60% conviction — kills the historical 24% / 8% / 4% noise (VLN, BBAI, QCOM cases).
  - **Overshoot gate** (`OVERSHOOT_TOLERANCE_PCT = 1.0`) fires only when current price is within 1% of zone level on cross-down — kills stale alerts where price plunged well below the zone in a single tick (CRM $178.30 firing at curr $176.17 case).
  - **Horizon collapse** — the engine writes 3 `entry_zones` rows per ticker (intraday + overnight + multiday); identical-or-near levels (within 1%) collapse to a single ping, highest-confidence horizon wins, ties broken multiday > overnight > intraday. All horizons in the cluster get `last_fired_at` stamped to suppress independent re-fires.
- **What remains in Batch C (still un-done):** per-marker cooldown UI (the schema field exists, the FE control doesn't); `at_or_above` markers getting their own channel rather than sharing `#upside-dip-buys`; stats-alert second trigger ("still in band 10 min later") if cross-into proves too sensitive in practice; any FE polish slices that emerge from further live observation.
- **Live verification:** takes effect on next `./bin/upside rebuild` cycle. Subsequent dip-buys alerts should show no sub-60% confidence, no overshoot fires, no triple-horizon spam. Manual markers (the audit found those firing cleanly) are unchanged.

### Tooling slice — bin/upside-psql + bin/upside-discord + PreToolUse hook (2026-05-30)
- Owner: claude
- Started + Finished: 2026-05-30
- Commits: 6426ac0 (wrappers) → 9e3f099 (hook)
- **What shipped:** silent dev-tool surface for the two most common ad-hoc reads + an enforcement hook that prevents regression:
  - **`bin/upside-psql`** forwards args + stdin to psql with `.secrets/readonly-db` as the connection-string source — heredocs work, creds never land on the command line. Role is `upside_readonly` (SELECT-only via grants), so writes rejected at the Postgres layer. Allowlisted via `Bash(bin/upside-psql:*)` so calls are prompt-free.
  - **`bin/upside-discord`** wraps the bot-token Discord read pattern from `.claude/skills/read-discord/SKILL.md`: `channels` lists channels, `<name|id> [N]` reads messages, `--raw` for piping to jq. Token from `.secrets/discord-token`. Bot has no post permissions, so read-only by token capability.
  - **`.claude/hooks/wrapper-bypass-guard.sh`** — PreToolUse hook that intercepts Bash calls, exits 2 (block) on raw `psql ` or `discord.com/api/` (without `bin/upside-` prefix), with an error message pointing at the right wrapper. Enforces [[feedback_use_wrappers_not_raw]]. Self-tested inline before commit.
- **Context:** memory entries written alongside ([[feedback_use_wrappers_not_raw]], [[feedback_no_subagents]]). The wrappers + hook were created after the 2026-05-30 subagent-on-worktree incident leaked the readonly DB password to a transcript log (subsequently rotated) — belt-and-suspenders so this can't recur.

### Batch B — Intraday-stats engine + typical-intraday-low band Discord alerts (2026-05-29)
- Owner: claude
- Started: 2026-05-29 13:11 · Finished: 2026-05-29 (server) → 2026-05-30 (FE + spec sweep)
- Commits: 11d2534 (migration 017 + `computeIntradayStats` pure function + 5 vitest scenarios) → 7a6bbb4 (`intradayStatsCron`, 24h cadence, IB-gated, first run 5min after boot) → 62bd5a5 (migration 018 `quotes.today_open` + `checkIntradayStatsForConid` from `upsertQuote` + `notifyIntradayStatsHit` → `#upside-stats-alerts`) → a3a072a (FE: `IntradayStatsChip` on watchlist rows + `IntradayStatsPanel` collapsible on TickerDetail + `useIntradayStats(symbol)` hook + `today_open`/`statsByConid` in `useWatchlistData`). Two parallel fixes folded in just before B (df193d3 markers per `(user_id, conid)` not per item — migration 016; ff2e803 round-magnet removal + MTD card removed + marker-chip nowrap CSS).
- **User-confirmed picks (2026-05-29):** all 3 stats (open-fade / close-fade / intraday-low), 60-day lookback (user reasoned "I want both intraday and multi-day deals" — 60d is the intersection of "recent enough to reflect now" and "deep enough that outliers don't dominate"), **separate** Discord channel `#upside-stats-alerts` (env `DISCORD_WEBHOOK_STATS_ALERTS`, blue embed) so the user can tune attention per source.
- **Engine: end-to-end.** `services/intradayStats.ts` pure `computeIntradayStats({bars, lookbackDays?, fadeBars?})` groups 5-min bars by ET session, computes 3 stats per session, summarizes across sessions as mean/p50/p25-or-p75; 5 vitest scenarios (typical fade, no-fade, lookback respect, empty input, p75-deeper-than-p50) green. `cron/intradayStatsCron.ts` 24h-cadence; per active-list conid: `ibHistory(conid, '2m', '5mins')` → compute → upsert. IB-off = no-op (honest staleness; `computed_at` surfaced on FE). `services/intradayStatsAlerts.ts checkIntradayStatsForConid(conid, symbol, prev, curr)` fires from `upsertQuote` on every canonical price write (alongside markers + entry-zones). Band: `band_top = today_open × (1 − p50/100)`; fire on `prev > band_top AND curr ≤ band_top`; 24h cooldown anchored on `intraday_stats.last_fired_at`. All three pollers (ibPricePoller / finnhubPricePoller / watchlistQuotePoller) thread `today_open` (IB snapshot field `7295` / Finnhub `quote.o`) into `upsertQuote`.
- **FE surfaces:** `components/Watchlist/IntradayStatsChip.tsx` — compact `▼ X.X% / p50–p75` chip in the right-side cluster, three color states `above` (dim) / `typical` (event accent) / `deep` (buy accent, bold) based on today's drop vs. the band; hidden when no stats row or no `today_open` (em-dashes would be noise). `components/TickerDetail/IntradayStatsPanel.tsx` — 3 stats × 3 percentiles table in a new collapsible section with lookback+sample+computed_at footnote, explicit nightly-cron empty-state copy. `useWatchlistData` adds `statsByConid` + intraday_stats Realtime sub + `today_open` on `QuoteRow`. `useIntradayStats(symbol)` is the single-symbol hook for TickerDetail (keys by symbol — `intraday_stats.symbol` is indexed in migration 017 for exactly this).
- **Spec sweep (2026-05-30):** new `spec/signals/stats.md`; cross-links in `spec/README.md`, `spec/schema.md` (intraday_stats row + `quotes.today_open` + `quotes.today_change_pct` + `quotes.sparkline_closes` + watchlist_markers re-keying note), `spec/flows.md` (Intraday-Stats Update + Hit Flow + Marker-Hit-Flow keying note), `spec/screens/watchlist.md` (chip + layout + glossary), `spec/screens/ticker-detail.md` (Intraday-stats collapsible), `spec/screens/portfolio.md` (MTD card removed, prior design preserved as a forward-pointer), `spec/signals/markers.md` (per-conid keying), `spec/signals/entry-zones.md` (round-magnet exclusion). `BUILD_QUEUE.md` Completed section now carries A1/A2/A+/B + the two polish slices; Un-done block introduces the post-pivot pick-order pointer (next un-done is Batch C sketch or Batch 13.2 — user decides on "continue").
- **Pending before user-verified live** (the only steps left, hands-off-VPS per `feedback_infra_handson`):
  1. Apply migrations `017_intraday_stats.sql` + `018_quotes_today_open.sql` to Supabase. (016 already applied with the marker re-keying.)
  2. Create Discord channel `#upside-stats-alerts`, set `DISCORD_WEBHOOK_STATS_ALERTS` in VPS `.env`.
  3. `./bin/upside rebuild` on the VPS. First `intradayStatsCron` run is 5min after boot; chips/panel populate as conids get covered.
- **Live verification by user** (after the rebuild): row chips appear with sensible color states on active-list tickers; Intraday-stats collapsible on TickerDetail renders the 3×3 table; a price crossing the typical-low band fires once in `#upside-stats-alerts`. Alert-cadence tuning ("does this fire too often / too rarely?") deferred to the Batch C sketch alongside A2/A+ tuning.

### Polish slice — Markers re-keyed to (user_id, conid), round magnets removed, MTD card removed, marker chip nowrap (2026-05-29)
- Owner: claude
- Finished: 2026-05-29
- Commits: ff2e803 (round-magnet removal + MTD-card removal + marker-chip nowrap CSS) → df193d3 (migration 016 markers re-keyed to `(user_id, conid)`, markers.ts query rewrite, watchlist-markers route rewrite, FE `markersByItem` → `markersByConid`).
- **User direction (2026-05-29):** "ticker that appears in both lists Next and Splitting, has a price marker in Splitting and shows, but the price marker doesn't show in list Next, price marking is per ticker per watchlist and not per ticker and global for watchlists which is a bug. Also the round number magnets — they're not very useful, see channel dip-buys in discord… it set a price higher than the current price and tells me to buy below it, aka buy market, that's dangerous. Small css issue — when the stock price is high like over 1k, the manual marker becomes 2 vertical rows which is bad. Remove MTD, we don't need it anymore."
- **What shipped:** Migration 016 unique-key `(user_id, conid, label, price, condition)`; backend reads markers by conid directly (no item join); FE adds `markersByConid` from a single conid-scoped query. `computeEntryZones` candidate collector no longer pushes round-number levels (no half-dollar / dollar magnets) — they generated "buy below $X" zones above current price, reading as "buy market." `SummaryStrip` MTD card stripped; only Portfolio value remains. `.marker-chip { white-space: nowrap }` so a $1234.56 chip stays one row.
- **Live-verified by user (2026-05-29):** markers on a conid now appear in every list it's in; no round-magnet zones in `#upside-dip-buys` after the rebuild; portfolio screen single-card; high-price marker chip stays one row.

### Polish slice — Vercel SPA rewrites for hard-refresh (2026-05-29)
- Owner: claude
- Finished: 2026-05-29
- Commits: de1b4f8 (initial vercel.json with rewrites + `comments` field) → 263a983 (strip `comments` — failed Vercel schema validation).
- **What shipped:** `client/vercel.json` rewrites every non-static path (excluding `/assets/`, `/sw.js`, workbox-*.js, manifest, favicon, robots) → `/index.html`, so hard-refreshing `/watchlist`, `/ticker/:symbol`, `/settings` no longer 404s on Vercel.
- **Live-verified by user (2026-05-29):** hard refresh on inner routes now reloads the SPA cleanly.

### Batch A+ — Dynamic entry-zone engine + vitest test suite + watchlist row polish (2026-05-28 → 2026-05-29)
- Owner: claude
- Started: 2026-05-28 21:55 · Finished: 2026-05-29 13:00
- Commits: 5a70632 (migration 013 + engine) → d9c0285 (vitest + 8 scenario tests) → 25f98df (entryZonesCron) → a3fdf65 (FE chips) → 5ade427 (Discord alerts on zone crossing) → 3ccaaa4 (migration 014: company_name + sync writes it) → e681250 (migration 015: today_change_pct + sparkline_closes) → cc77fc3 (layout B + collapsed cluster + glossary + promote-to-marker) → 21c87e9 (price anchored top-right; company ellipsis; wider popover) → 1d6d050 (zone cluster inline in main row; left container width-set; popover opens leftward) → 37469e0 (markers + zone chip share one inline cluster) → de1b4f8 → 263a983 (Vercel SPA rewrites).
- **Engine: end-to-end.** `services/entryZones.ts` pure function, 8 scenarios via `pnpm test:server`. `entryZonesCron` (15-min) writes per-(conid, horizon) rows for active watchlist conids and piggybacks the 7-day sparkline. `services/entryZoneAlerts.ts` fires Discord (`#upside-dip-buys`, same channel as markers) when price crosses a zone band, 24h cooldown anchored on `entry_zones.last_fired_at`.
- **FE polish converged with the user** over five rounds: layout B (price hard-right anchor) → collapsed overnight chip with hover/tap popover + tap-to-promote-to-marker + glossary help icon → absolute-positioned price column (always same spot) + company-name ellipsis at 16ch + bigger popover → zone cluster moves into the main row + left container width-set so sparkline anchors next to symbol/company + popover anchored right opens leftward → markers + zone chip share one inline chip cluster right-floated with flex-wrap, removing the chips-below row entirely.
- **Vercel SPA fix (263a983):** `client/vercel.json` rewrites every non-static path to `/index.html` so hard-refreshing `/watchlist`, `/ticker/:symbol`, `/settings` no longer 404s. (Strict-JSON only; the earlier `comments` field failed Vercel's schema validation — stripped.)
- **Live-tapped by user (2026-05-29):** layout reads well; markers + zone aligned; company ellipsis works; popover opens cleanly without overlapping price. Discord-alert *behavior* (zone crossing → ping) explicitly deferred to "future verification" by user, alongside alert-tuning (which zones fire / throttling).

### Batch A2 — Manual price markers + dip-buy Discord alerts (2026-05-28)
- Owner: claude
- Started: 2026-05-28 21:23 · Finished: 2026-05-28
- Commits: 7eb055e (migration 012) → 650b013 (markers service + dip-buy notifier + CRUD route + quote-write hook) → 10551e7 (FE marker chips + add/edit sheet + long-press handler).
- **What shipped:** Migration 012 (`watchlist_markers` keyed by item_id with the geometric condition vocab + per-marker cooldown + last_fired_at). `services/markers.ts` `checkMarkersForConid(conid, symbol, prev, curr)` does transition-based crossing detection per condition (at_or_below / at_or_above / about), gated by cooldown. At_or_below fires Discord; the other conditions update last_fired_at without notifying so when their channels land they don't fire on historical crossings. `quotes.upsertQuote` reads prior canonical_price + fires marker check fire-and-forget after each write. `routes/watchlist-markers.ts` POST/PATCH/DELETE with explicit owner-chain validation. FE: `MarkerSheet.tsx` add+edit+delete (with `prefill` prop added in A+ for promote-from-zone); `Watchlist.tsx` 500ms pointerDown timer + onContextMenu for long-press / right-click → add-marker sheet.
- **Live-verified by user (2026-05-29):** marker creation works; chip renders inline alongside the zone cluster. Discord alert path itself deferred for future verification by user direction.

### Batch A1 — Watchlists + IB import + quotes table + TickerDetail-for-non-held (2026-05-28)
- Owner: claude
- Started: 2026-05-28 · Finished: 2026-05-28
- Commit: c0fe0f3 (final IB-wrap fix); arc: aa345f8 (migration 011) → ab0b6ad (service+route) → 7d2940b (poller mirror + watchlistQuotePoller) → 9a6b13e (FE tab+page+import+settings sheet) → 881cd28 (TickerDetail for non-held) → facd4d5 (stale shares=0 + sync.empty diagnostic) → c0fe0f3 (unwrap .data).
- **What shipped:** migration 011 (`quotes` keyed by conid with both `ib_price`+`finnhub_price` side-by-side + canonical_* triple; `watchlist_lists` with active default false; `watchlist_items`). `services/watchlists.ts` orchestrates IB sync (filter to user_lists, preserve owner-set `active`, delete IB-orphaned items). `routes/watchlists.ts` exposes POST /sync (IB-gated, 403 ib_required) + PATCH /:id. `services/quotes.ts` `upsertQuote` + `activeWatchlistOnlyConids` helpers. ibPricePoller + finnhubPricePoller mirror held prices into `quotes` per cycle; new `watchlistQuotePoller` (60s) covers watchlist-only conids via batched ibSnapshot or per-symbol Finnhub. FE: Watchlist tab in bottom nav, `pages/Watchlist.tsx` with empty state + import + per-list active toggle in gear-icon settings sheet + sub-tab strip + ticker rows. `useTickerDetail` falls back to watchlist_items+quotes lookup when not held (Position Stats hidden).
- **Live-verified by user (2026-05-28):** migration applied; rebuild done; Import from IB → "Imported N lists" ✓; unhid the "Next" list → sub-tab + rows with live prices ✓. Two bugs caught + fixed during verify: (a) stale RGTI shares=0 row — `ibPricePoller` now filters `position!=0` so closed positions get orphan-deleted; (b) sync silently returned imported=0 because IB now wraps the payload in `{ data: {...}, action, MID }` (older capture didn't) — parser updated to unwrap `.data` with fallback. The silent-success bug surfaced the user's "why no global error catcher" critique → added `watchlists.sync.empty` notify that fires when 200 returns but extracted user_lists is empty (which is exactly what found the wrap bug). Pattern recorded: **result-anomaly notifies** for "succeeded with no work" cases sit alongside the existing error infrastructure (notifyError / notifyCritical / instrumented-API auto-notify / express error middleware / process handlers).
- **Known follow-ups (deferred, not blockers):**
  - **Watchlist row is too thin** — currently just symbol + price + source. Spec calls for company name (lookup from `contracts`) · today's change · sparkline · source pill. Polish slice queued after A2 + A+ per user direction (2026-05-28).
  - **Analyze on non-held tickers** still reads `positions.current_price` in signalEngine — produces honest `no_signal "live price stale"` for watchlist tickers. Small follow-up: switch engine's canonical-price read to `quotes.canonical_price`. Not urgent since LLM signals are deferred behind the watchlist pivot.

### Batch 14g — Single-direction playbook engine (2026-05-26, closed under the 2026-05-28 pivot)
- Owner: claude
- Started: 2026-05-26 · Commits: 8631379 (code) · ce6166f (spec/schema) · 68fe0ea / 595cb90 (prompt fixes)
- Replaced the unified SELL+BUY analysis (14a) with a **single-direction playbook**: direction by holding (held→SELL, not-held→BUY), a computed feature pack in `technicals.buildFeaturePack` (pivots / swing H-L / 20d+52w H-L / ATR / SMA-EMA / RSI / MACD / Bollinger / VWAP / rel-vol / position-relative), a Zod playbook output (legs + per-leg confidence + horizon), one `analyses` + one `signals` row (leg[0]→`price_range_*`, full legs→`playbook jsonb`), level-anchored single-direction prompt with the profit-zone trigger wired in. Migration `010_playbook.sql` (+ `analyses.refined_from_analysis_id`, reserved for the Refine follow-up → now roadmap Track 4 item 8). FE renders ordered legs in SignalSection.
- **Live-validated (BBAI, 2026-05-27):** well-formed multi-leg playbooks; fixed float-noise in `price_range_low` (round to 4dp) and a "sell-now" bias (geometric condition rule + resting-order framing). Remaining gap is *judgment quality* (the `structure` feature mislabels coiling-near-lows) — spec'd as a deferred follow-up in `spec/signals/playbook.md` + `spec/roadmap.md`.
- **Closed under the 2026-05-28 watchlist pivot:** the engine is validated; remaining sharpening lives in the deferred queue (LLM-analysis roadmap Track 4). Durable design in `spec/signals/playbook.md`.

### Batch 14.5 — Schema cleanup: remove `position_history` (2026-05-26)
- Owner: claude
- Started: 2026-05-26 · Finished: 2026-05-26
- **Finding: no-op at the schema level.** `position_history` was already absent — the baseline `001_initial.sql` doesn't define it (only a comment noting it was dropped), the live DB confirms `to_regclass('public.position_history')` is null, and no server/client code references it. So the batch's acceptance (`select * from position_history` → "relation does not exist") was already met. **No drop migration added** — a `drop if exists` against a table that never existed in any deployed environment would be pure cargo-cult.
- **What changed:** corrected a stale comment in `001_initial.sql` that claimed MTD comes from "IB's account summary endpoint" — it actually comes from the Redis-cached month-start value (Batch 13.5). Credited the close to 14.5. (Spec — `schema.md`/`archive.md`/`architecture.md` — already described the table as removed; no spec change needed.)

### Batch 14c — Profit-taking zone detection + Discord notifications + card UI (2026-05-26)
- Owner: claude
- Started: 2026-05-26 · Finished: 2026-05-26
- Commit: 71897ff
- **What shipped:** continuous detection that a position crossed its profit-taking threshold, a Discord ping on entry, and card UI.
  - **Schema** (migration `009_profit_zone.sql`): `positions` gains `zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap`; `user_preferences` gains `profit_zone_threshold_pct numeric default 2.0` (check > 0).
  - **Shared state machine** (`services/profitZone.ts`): `computeZoneState(prev, pnlPct, threshold)` returns the next zone fields + `changed`/`notify`. Entry (`!inZone→inZone`) stamps `zone_entered_at`, sets `entered_zone_via_gap` when the market period is pre-market/closed, and flags `notify` only if `last_zone_notification_at` is >4h old (cooldown). Exit clears `zone_entered_at`, stamps `zone_exited_at`, never notifies. `getProfitZoneThreshold(userId)` reads the pref (defaults 2.0).
  - **Both pollers** (`ibPricePoller`, `finnhubPricePoller`) recompute zone state on every write and fire `notifyProfitZoneEntry` on a fresh, cooldown-passed entry. IB poller adds zone to its change-detection so a transition always persists.
  - **Discord** (`notify.ts:notifyProfitZoneEntry`): posts to `DISCORD_WEBHOOK_ZONE_PROFIT` (one webhook per alert type so each channel can be muted/enabled independently — pattern `DISCORD_WEBHOOK_<TYPE>`, future ZONE_DRAWDOWN / SIGNAL_SELL etc.); no in-memory cooldown — the 4h re-entry cooldown is DB-anchored (`last_zone_notification_at`) so it survives restarts.
  - **Daily cleanup** (`cron/zoneGapCleanup.ts`): clears `entered_zone_via_gap` once per ET day after the regular session ends. `marketHours.etDateString()` added.
  - **FE:** `Position` gains `zoneEnteredAt`/`enteredZoneViaGap` (mapped in `usePositions`); `PositionCard` renders a zone icon (+ "GAP" badge) before the P&L when in zone, each wrapped in a new `common/Tooltip` (hover desktop / tap mobile, ESC + outside-click dismiss, stops card nav). CSS for icon/badge/tooltip.
- **Deferred (deliverables 4 + 6):** feeding `inProfitTakingZone` into the LLM prompt + the inline "Analyze for profit-taking?" shortcut — both entangled with the pending single-direction signal-engine redesign (see Known issues), so deferred to avoid prompt churn. Detection/notification/UI are independent and shipped.
- **Status: verified live (2026-05-26).** Migration applied, `#upside-zone-profit` channel + `DISCORD_WEBHOOK_ZONE_PROFIT` configured, VPS rebuilt. BBAI crossed +2% (default; no `user_preferences` row yet → fallback) → DB showed `zone_entered_at` + `entered_zone_via_gap` + `last_zone_notification_at` set; user confirmed the Discord ping, the zone icon, and the GAP badge on the card.
- **Follow-up fix shipped same day:** a pre-market price flicker (BBAI 4.28↔4.18, total tracking it) traced to `finnhubPricePoller` overwriting a steady IB price with Finnhub's delayed prior-close quote — diagnosed from a user HAR (`src=finnhub price=4.18` then `src=ib price=4.28`). Fixed by gating the Finnhub poller on IB connection status (skip while IB connected) rather than the leaky 90s per-row staleness. See commit + `architecture.md`.

### Batch 14e — Marketdata snapshot endpoint + TickerDetail wire-up (2026-05-26)
- Owner: claude
- Started: 2026-05-25 16:01 · Finished: 2026-05-26
- Commits: (snapshot endpoint + caching arc) 282212c → e7f83cc → 849e24c → **542939c** (4-up grid / volume cap / chart tag) + **6bea739** (spec).
- **What shipped:** `GET /api/marketdata/snapshot/:symbol` powering TickerDetail's Today's Range + Market Stats (were hardcoded `0`/`[]`).
  - **Endpoint** (`routes/marketdata.ts`): `getIntraday()` is IB-primary (snapshot fields 31/70/71/82/83/87/7295/7296) when the IB session is live, gap-filled from one cached Finnhub `/quote` (`source: ib|finnhub|mixed|none`); `getFundamentals()` from Finnhub `/stock/metric?metric=all` (52w hi/lo, peTTM, epsTTM, beta, marketCap, 10d avg vol, dividend). `parseAbbrev()` parses IB's K/M/B/T suffix strings. Two-tier Redis cache by volatility — intraday 60s, fundamentals 6h — so reopening a ticker is cheap (IB-on = 0 Finnhub calls; IB-off = ≤1 `/quote`/60s + ≤1 `/stock/metric`/6h per symbol).
  - **0-as-unknown:** IB returns `0` for fields on a closed market; `nz()` maps `0→null` then Finnhub gap-fills, so closed-market fields show real values (e.g. open `$4.23`) instead of `$0.00`.
  - **Volume sanity-cap:** IB field 87 occasionally returns a wrong-magnitude string (observed `"65595.7B"` ≈6.6e13 for a ~65M-vol stock); `VOLUME_SANITY_CAP = 2e10` rejects it to null (cell shows "—"; Finnhub free `/quote` has no volume).
  - **FE:** `useTickerDetail` fetches the snapshot in its own effect, merges day-range + builds the Market Stats pool (`buildMarketStats`); `MarketStats` re-seeds via `useEffect` since the snapshot resolves after mount. 4-per-row grid renders every enabled stat (no fixed height/cap); 52w range is a compact text cell ($3.01–$9.39), the separate 52w bar removed. Chart volume histogram keeps its bars but drops the per-bar last-value tag (the "5.59K" read as a misleading daily total).
- **Status:** code committed + pushed (FE auto-deploys via Vercel). **BE volume-cap needs `./bin/upside rebuild` on the VPS** to take effect. Server + client typecheck clean, client build clean. Live diagnosis done via IB passthrough capture ($0.00 + 65.60T bugs both root-caused on real data); final FE-flow visual confirmation is user-driven.
- **Deferred (see Known issues):** loading/error "coming soon" states; empty Indicators section.

### Batch 14f — TickerDetail real-data chart + signal polish (2026-05-25)
- Owner: claude
- Started: 2026-05-25 18:19 · Finished: 2026-05-25 15:59
- Commit: 0b718c4
- **What shipped (FE-only, Vercel):** four chart/signal fixes from Batch 14a's follow-up list. (1) RSI subchart — `utils/rsi.ts` computes RSI client-side from fetched candles; line renders inside the banded pane, bands only when RSI data present (was hardcoded `rsi:[]`). (2) Y-axis scaling — explicit `rightPriceScale.scaleMargins` (tighter top) so the high sits near the top edge instead of ~5% over. (3) Entry/position-price line — avg-cost line made prominent + labeled ("Avg $XX.XX"); "Entry" date marker renders only when `first_seen_at` falls inside the visible candle window (was pinned to the left edge via a fallback). `first_seen_at` threaded through `useTickerDetail` → `positionStats.entryDate`. (4) Collapsed Signal section pills — `CollapsibleSection` gains optional `headerAccessory`; `TickerDetail` lifts `useSignals` (one subscription shared with `SignalSection`) and renders the `SignalPill` row in the header so actionable signals stay visible when collapsed.
- **Status:** code committed + pushed, client typecheck clean. Visual confirmation on the live Vercel app pending user walkthrough (FE-flow verification is user-driven); flag any visual issue as a follow-up.

### Batch 14a — Signal engine + manual unified analysis end-to-end (2026-05-25)
- Owner: claude
- Started: 2026-05-25 · Finished: 2026-05-25
- Commits: 185b793 (engine + schema 008) → 0556976 (SignalPills on cards) → d7eb7a8 (008 re-runnable) → bcc700f (multi-provider LLM + honest failure classification) → 046b60b (on-the-fly provider/model selection via app_config + Settings).
- **What shipped:** tap Analyze → unified SELL+BUY analysis lands + renders. Migration 008 (analyses table + signals reshape: buy/no_signal types, analysis_id, motivation, rationale, whole-analysis supersede). signalEngine orchestrates IB history+snapshot + Finnhub + technicals → one Zod-validated LLM call (one stricter retry on malformed, else no_signal fallback) → persists 1 analyses + 1-2 signals + supersedes prior. Route: 5-min soft-block (429 recent_analysis), daily ceiling (429 daily_limit_reached), 202 async. FE: two-step Analyze, soft-block + daily-limit UIs, shared-reasoning + per-direction SELL/BUY blocks, SignalPill on TickerCards, useSignals/useAnalysisLock Realtime hooks.
- **Multi-provider LLM:** one OpenAI-compatible provider for groq/mistral/openrouter/openai (presets carry base URL + default model); gemini stays native REST. `LlmError{kind}` classifies non-2xx (429→rate_limited, 401/403→config, else unavailable); only a 2xx-with-bad-shape is `malformed`. Engine re-prompts only on `malformed`; rate-limit/outage/bad-key fail soft with an honest reason. Malformed errors carry a 400-char raw-body snippet to #errors. `LLM_BASE_URL` env override dropped — base URL coded per provider.
- **Dynamic provider/model selection** (pre-builds Batch 15's LLM dropdown): selection in `app_config` (`llm_provider`/`llm_model`); keys stay in `.env`. `appConfig.ts` (generic get/set), `llmConfig.ts` (app_config→env fallback), `routes/config.ts` (`GET`/`POST /api/config/llm`, validates provider implemented+keyed). FE `useLlmConfig` (Realtime-synced) + Settings "Analysis engine" picker.
- **Verified live (2026-05-25):** Gemini free tier 429'd on a single analysis (drove the multi-provider work); switched to Groq (`llama-3.3-70b-versatile`). BBAI happy path → SELL+BUY rendered on FE, #errors clean. Soft-block confirmed ("Last analyzed 3 min ago — re-analyze anyway?"). Forced re-run produced different SELL/BUY and whole-analysis supersede confirmed in psql (first analysis's rows `superseded_by_analysis_id` set; latest current). Manual prereq done: `LLM_PROVIDER=groq` + keys in VPS `.env`.
- **Known follow-ups (TickerDetail, not blockers):** chart RSI subchart hardcoded `rsi:[]` for real data (bands render, no line); chart Y-axis top margin too wide; entry/position-price line too faint + "Entry" marker mislocated; collapsed Signal section doesn't show pills. Market stats / day high-low still await the marketdata-snapshot endpoint (separate batch). Daily-limit + crash-recovery edge paths coded but not individually live-tested.

### Batch 13.5 — `tradingDaysHeld` + MTD return (2026-05-25)
- Owner: claude
- Started: 2026-05-23 · Finished: 2026-05-25
- Commits: 4cc5536 (initial) → 745424f (two-tier entry-date) → 94f1bba (persistence fix). All on dev, deployed to VPS.
- **What shipped:** exact entry-date provenance per position + derived `trading_days_held` / `daily_return`, plus month-to-date portfolio return.
  - Migration 007: `first_seen_at` + `first_seen_source` on `positions`.
  - `resolveEntryInfo` (ibPricePoller) reconciles entry date on first sight + re-attempts hourly while `source='observed'`; trusts `ib_transactions` permanently.
  - **Two-tier entry resolver** (ibGateway): Tier 1 `entryFromTrades` — `/iserver/account/trades` intraday fills (~7-day window), back-computes pre-window balance and walks `trade_time_r` order to the most recent 0→+ crossing (catches a flatten + re-open). Tier 2 `entryFromTransactions` — `/pa/transactions` day-level, order-independent, for entries older than the trades window. Falls back to `now()` + `source='observed'` when neither reconciles.
  - `marketHours.tradingDaysHeld`: weekday + US-holiday-aware counter. `daily_return = unrealized_pnl_pct / daysHeld`.
  - `services/mtdCache`: per-user Redis SET-NX anchor at first poll of each month (TTL 60d); `/api/portfolio/summary` returns `mtdReturn` + `mtdReturnPercent` (null until an anchor exists).
  - FE: `PositionStats` renders "≥N days"/"≤X%/d" floor when `source=observed`, exact when `ib_transactions`; `SummaryStrip` shows MTD (handles null with "—").
- **The bug chain (1→5, each fix revealed the next):** (1) self-lock — resolver only ran when `first_seen_at IS NULL`, pinning a failed first attempt to 'observed' forever; (2) `/pa/transactions` body — needs `currency:'USD'` (else 400) and **numeric** `days` (string → 500); the earlier "PA cold-start" warmup was a misdiagnosis, reverted; (3) double-negated sells — pa `qty` is already signed, walker mustn't re-negate; (4) same-day ordering — pa is day-level with unreliable intra-day order, blind to a sell-to-0-then-rebuy, which drove the two-tier design; (5) **persistence skip** — `pollCycle` change-detection excluded `first_seen_*`, so with the market closed (IB snapshot price == finnhub's last write → no price field moves) a freshly-resolved date was recomputed every cycle but never upserted, and the hourly throttle re-locked it to 'observed'. Fix: force an upsert when `first_seen_source`/`first_seen_at` differs.
- **Verified live (2026-05-25, post-deploy):** BBAI → `first_seen_source=ib_transactions`, `first_seen_at=2026-05-20 15:41:40+00` (the re-buy execution, to the second), `trading_days_held=3`, `daily_return` non-null (psql); `/api/portfolio/summary` → `mtdAnchor=9799.5`, `mtdReturn=23.5`, `mtdReturnPercent=0.24%`. FE render confirmed by user.
- **Known limits / minor follow-ups:** an intraday flatten >7 days ago is unrecoverable from IB (trades window only ~7d) → falls back to day-level. `daily_return` can briefly lag `unrealized_pnl_pct` because the finnhub poller refreshes PnL% but not `daily_return` (re-synced on the next IB write with PnL movement). On Connect, ibPricePoller waits up to one cadence before its first cycle (inherited from 13.8).
- **Tooling unlocked along the way:** read-only POST passthrough (`bin/upside-ib --post`) for live IB probing; `upside_readonly` psql access from WSL via the `aws-1-...` pooler (see `query-supabase` skill) — verification now runs directly via psql.

### Settings screen (minimal) + copy-JWT dev tool (2026-05-24)
- Owner: claude
- Replaced the `/settings` ComingSoon placeholder with a real (minimal) Settings page: shows signed-in email + a "Copy access token" button that copies the live Supabase `access_token` to the clipboard (with a reveal-to-select fallback when the Clipboard API is blocked). Purpose: stop hand-copying the JWT from DevTools for `bin/upside-ib` / passthrough debugging.
- Security: page renders only inside `<AuthGuard>` (whole app is wrapped at App.tsx root), so an unauthenticated/deep-link visitor gets Login, non-whitelisted gets signed-out + bounced to google.com. The JWT is read from the live session at click time — not baked into the bundle, and `getSession()` returns null without a real authenticated session, so there's nothing to copy for a non-authenticated user. BE still enforces `requireAuth` on every route.
- Partial pre-build of Batch 15 (Settings wired) — that batch should expand this page (IB connection, thresholds, theme, sign-out) rather than start from scratch.
- Deploy: FE is on Vercel (separate from the VPS api rebuild).

### Discord error observability — funnel external-API failures (2026-05-24)
- Owner: claude
- Problem: Discord (our error-observability tool) showed almost nothing — only ~1 critical/day. Every IB/Finnhub non-2xx was recorded to `external_api_metrics` but never notified, so the `/pa/transactions` 500 (and all API errors) were invisible.
- Fix: single policy `notify.notifyApiFailure(key, status, detail)` owns the routing — routine channel, rate-limited per endpoint, **suppresses expected churn** (status<400, 401/403 session transitions, 429 rate-limits, status-0 throws which the caller's catch owns). Wired into IB's `instrumented` + `instrumentedWithRetry` wrappers (`ib_api.<endpoint>`) and Finnhub's `call` wrapper (`finnhub_api.<category>`). Critical stays for structural breakage (process/loop crash, Supabase ping) — not funneled through the policy. Env vars: `DISCORD_ERRORS_WEBHOOK_URL` / `DISCORD_ERRORS_CRITICAL_WEBHOOK_URL`.
- Known follow-up: per-call API errors all go to *general*; no auto-escalation to critical on sustained failure of a core path yet.

### Batch 13.8 — Multi-source price polling (IB primary, Finnhub fallback)
- Owner: claude
- Started: 2026-05-17
- Finished: 2026-05-17
- Commit: 9577306
- Notes: pricePoller.ts renamed → ibPricePoller.ts; new finnhubPricePoller.ts runs always-on at 60s cadence; both write to the same `positions` rows with `price_source` ('ib'|'finnhub') tracking the active provider. Migration 006 adds price_source + last_price_update_at + check constraint + lookup index. Finnhub poller skips positions whose IB-sourced update is fresher than 90s; on takeover updates only price-derived fields (current_price, market_value, unrealized_pnl, today_change/_pct) plus a recompute of portfolio_weight + portfolio_contribution across the user's full set. IB-authoritative fields (shares, avg_cost, vwap, daily_return, trading_days_held, industry) stay untouched by the fallback. Round-trip verified: IB→Finnhub takeover after ~120s of IB disconnect; IB regains on next IB poll. Small price discrepancies between providers (1c-50c on BBAI/OKLO weekend test) are normal multi-source aggregation drift, not a bug. Known follow-up: on Connect, ibPricePoller waits up to one full cadence (5min when markets closed) before its first cycle — could trigger an immediate poll on auth-transition for snappier reconnect UX.

### Batch 13.7 — Finnhub rate-limited request queue + instrumentation audit
- Owner: claude
- Started: 2026-05-17
- Finished: 2026-05-17
- Commit: e468cc0 (instrumentation cleanup); arc: 9dc5fd8 (queue + migration) → 1e2e313 (retention cron) → e468cc0 (drop low-value endpoints)
- Notes: finnhubQueue.ts (token bucket + per-(category,key) min-interval, no stale-cache returns). Migration 005 renames ib_api_metrics → external_api_metrics + adds provider column. All Finnhub HTTP calls in finnhub.ts route through the queue and write provider='finnhub' audit rows. 30-day retention cron landed mid-batch when user surfaced 11K rows after 2 days. Audit of the metrics table found no code reading it; reduced instrumentation to the endpoints with concrete tuning value (positions, snapshot, history, debug-passthrough, finnhub:*) and dropped 5 low-value endpoints (auth/status, tickle, logout, contract/info, secdef/search). Estimated ~70% row-volume reduction going forward.

### Batch 13.2 — Generic IB passthrough debug endpoint
- Owner: claude
- Started: 2026-05-17
- Finished: 2026-05-17
- Commit: 978e640 (capture reorg); arc: d00ee51 (endpoint + allowlist + docs) → 9ea178e (bin/upside-ib v1) → 978e640 (reorg)
- Notes: GET /api/debug/ib-passthrough proxies allowlisted read-only IB Client Portal paths and returns raw responses. Auth-gated (whitelisted email + Bearer); GET-only by route; positive regex allowlist; forbidden families documented (orders/, reply/, scanner/, place/cancel/modify). Logs to ib_api_metrics with debug-passthrough:<path> tag. Helper script bin/upside-ib calls it from the laptop — reads JWT from gitignored .secrets/supabase-jwt, discovers api URL from Supabase, saves output to captures/<path>/latest.json + timestamped archive. Acceptance use-case completed: captured /v1/api/iserver/watchlists, /v1/api/iserver/watchlist?id=100, /v1/api/iserver/accounts. Schema findings for the future post-MVP Watchlist track captured back into UPSIDE_MVP_SPEC.md → "Track 1: Watchlists + BUY Signals" Data Model + Sync mechanism (system_lists-vs-user_lists filter, modified_at column, asset_class column, STK-only Analyze).

### Batch 13.1 — Restore navigation + deeper /healthz
- Owner: claude
- Started: 2026-05-17
- Finished: 2026-05-17
- Commit: baf11e4 (rebuild rename); whole arc: 8b83bac (main fixes) + b7c76a2 (build-on-restart) + baf11e4
- Notes: BottomNav had Screener+Chat (post-MVP) instead of Settings; routes.tsx missing /settings; TickerDetailPage still on mockPositions. Fixed all three. TickerDetailData.signal and .positionStats made nullable so the screen renders against real Supabase data with placeholders for fields not yet produced (day high/low, market stats, indicators, signal — those land in 14a + a future marketdata batch). /healthz expanded to component-status JSON with 1s sub-check timeouts (ib/supabase/redis + lastPricePoll). pricePoller now stamps lastSuccessfulCycleAt for the health endpoint to read. Two operational fixes alongside: `./bin/upside rebuild` (was `restart`, more honest name) now always builds + force-recreates so code changes can't silently fail to deploy.

### Batch 13 — Vercel FE deploy + on-demand IBeam
- Owner: claude (code) + Me! (manual deploy + 2FA approvals)
- Started: 2026-05-15
- Finished: 2026-05-16
- Commit: 7392946 (final tap-while-connecting fix); whole arc spans many earlier batch-13 commits documented in the queue.
- Notes: Vercel FE live at https://upside-client.vercel.app, PWA installed on Android, full live path verified end-to-end with REAL portfolio data on a Saturday: phone → Vercel FE → Supabase app_config → Cloudflare Quick Tunnel → api → IBeam → IBKR → positions in Supabase → portfolio screen populated. Final IB auth model is on-demand: ib-gateway tagged `profiles: [manual]`, user taps Connect/Disconnect/Cancel in the FE, api uses mounted Docker socket (dockerode) to start/stop the container. Cooperates with IBKR Mobile (one-session limit no longer fights us). pricePoller no longer gates on market hours — runs at adaptive cadence (10s / 60s / 5min) so positions populate even on weekends. Five IB-auth approaches explored along the way (documented in queue): programmatic POST → 401; api path-proxy → 404 on absolute paths; second Quick Tunnel → cookie issue; full-time IBeam → battle royale with IBKR Mobile; OAuth 1.0a → parked on `oauth-dev` branch awaiting IBKR approval. Discord error notifier (two channels — routine + critical) added under this batch so future iterate-build-test-debug loops are ~minutes instead of SSH-and-grep. 🎯 Data-only live milestone reached.

### Batch 12 — Google OAuth end-to-end
- Owner: claude
- Started: 2026-05-15 (today)
- Finished: 2026-05-15 (today)
- Commit: bfa1d52
- Notes: Login.tsx + AuthGuard.tsx + Supabase Auth (Google provider). Verified end-to-end on localhost:5173 against the deployed BE: whitelisted email lands on app, non-whitelisted bounces to google.com, access_attempts logs both. Follow-on fixes shipped under this batch: 003_service_role_grants.sql (resolves the deferred grants issue from batch 11; covers analysis_locks, access_attempts, contracts, ib_api_metrics), AuthGuard dedup-by-token with localStorage persistence (1 audit row per real auth event, not per reload), prompt=select_account on signInWithOAuth.

### Batch 11 — Self-healing Cloudflare Quick Tunnel + FE URL bootstrap
- Owner: claude
- Started: 2026-05-15 (today)
- Finished: 2026-05-15 (today)
- Commit: b4b88fa
- Notes: cloudflared compose service + 002_app_config.sql + tunnelWatcher.ts + FE apiUrl bootstrap. Self-healing test verified end-to-end (docker compose restart cloudflared → new URL in Supabase within ~15s). Three follow-on fixes shipped under the same batch tag: cloudflared user: root for logfile perms, service_role grant for app_config, optimistic-claim dedup in the watcher.

### Batch 10 — Deploy BE compose stack to Oracle VPS
- Owner: claude
- Started: 2026-05-14 20:36
- Finished: 2026-05-15 (today)
- Commits: 1d97339 (un-comment ib-gateway service), a87c8c3 (axios https + self-signed cert), d7ecc41 (compose IB_GATEWAY_URL → https)
- Notes: surfaced and fixed http→https scheme bug for IB Client Portal Gateway. Filed `analysis_locks` grants issue as deferred.

### Batch 8 — Supabase project provisioning
- Owner: Me!
- Started: 2026-05-14 20:26
- Finished: 2026-05-14 20:41

### Batch 9 — Real-time price loop + frontend wiring
- Owner: claude
- Started: 2026-05-14 19:50
- Finished: 2026-05-14 20:00
- Commit: c90b33b

### Batch 7.5 — Collapse migrations into single baseline
- Owner: claude
- Started: 2026-05-14 19:49
- Finished: 2026-05-14 19:50
- Commit: 6ed224b

### Batch 6 — Schema reconciliation + IB mappers + snapshot fix
- Owner: claude
- Started: 2026-05-14 17:50
- Finished: 2026-05-14 18:03
- Commit: f7cdfef

### Batch 7 — Raw IB Client Portal data capture
- Owner: claude
- Started: 2026-05-14 13:35
- Finished: 2026-05-14 16:26
- Commit: babbca8

### Batch 5 — Docker Compose + Supabase schema + Node.js API scaffold
- Owner: claude
- Started: 2026-05-14 10:14
- Finished: 2026-05-14 10:48
- Commit: 182fd29

### Batch 4 — Oracle VPS + Docker setup
- Owner: Me!
- Started: 2026-05-14 08:07
- Finished: 2026-05-14 10:07
- Commit: 41162b4

### Batch 3 — Ticker detail - chart integration
- Owner: cursor
- Started: 2026-05-11 10:14
- Finished: 2026-05-11 10:18
- Commit: 41162b4

### Batch 2 — Ticker detail - layout & static components
- Owner: cursor
- Started: 2026-05-11 10:07
- Finished: 2026-05-11 10:13
- Commit: 49f8740

### Batch 1 — Portfolio home screen
- Owner: claude
- Started: 2026-05-10 18:36
- Finished: 2026-05-11 09:01
- Commit: 86b0b83
