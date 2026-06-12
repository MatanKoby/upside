# Upside — Build Queue

Reference spec: [`spec/`](spec/README.md) (root files + `spec/signals/` + `spec/screens/` — see the README for the map)
Agent work tracking: `CLAIMS.md` (managed by coding agents)
**Completed history: [`BUILD_QUEUE_DONE.md`](BUILD_QUEUE_DONE.md)** — one-paragraph summaries of every shipped batch. Skim it for context when picking a new claim.

## How this works

- This file lists only **un-done batches** (in full); completed batches collapse to summaries in `BUILD_QUEUE_DONE.md` (git log + `CLAIMS_DONE.md` have the implementation history).
- Dependencies are listed where they exist — the agent decides execution order.
- Agents claim and track completion in `CLAIMS.md`.
- Batches are designed so two agents can work on different batches simultaneously without file conflicts.

---

## Un-done batches

> **Pick-order pointer for "continue".**  **Remaining un-done**, rough priority: **Batch X10.3** `[TIMED — US RTH]` (verify the catalyst pipeline end-to-end after the X10.x deploy; only meaningful 16:30–23:00 IDT with IB connected) · **Batch X8** (signal lab — measure/tune/explain the live engine signals) · **Batch 13.9** (Finnhub cadence tuning — unblocked, all live callers exist) · **Batch C remainder** (per-marker cooldown UI, `at_or_above` channel routing, stats-alert second trigger) · **Batch ARCH** (architecture review + research sweep — incl. a job/task trigger + precondition coverage audit) · **Batch 16** (UI/UX polish + a11y — now incl. the shared global app header; push moved to roadmap). **Blocked / deferred:** 13.3 (waiting on IBKR support reply re secondary-user market-data cost). When the user types "continue" after a context clear, **ask** which un-done batch to claim.

---

## Batch X10.3 `[TIMED — US RTH]`: Verify catalyst pipeline end-to-end

**Depends on:** X10 + X10.1 + X10.2 (all shipped) **deployed to the VPS**.

**A verification batch, not code** — run the checks live, record the verdict in `CLAIMS.md`, and either close the catalyst track as validated or file a precise follow-up for the failing stage. Verified via `bin/upside-psql` (DB is the source of truth here; this is backend, not a UI flow).

**Precondition — when to claim:** only during **US RTH (16:30–23:00 IDT / 09:30–16:00 ET)** with **IB connected**, on a day the api has been up since at least ~boot+5min so the produce + advance loops have run. Off-hours the catalyst Stage-1 jobs are correctly deferred by the `requiresRthOpen` gate — nothing to see, **not** a failure. (That's why this is `[TIMED]`; don't claim it overnight.)

### Checks (each with its evidence query)
1. **IB up** — `quotes` has a fresh `canonical_source='ib'` row (updated < ~60s ago). If not, the `ib` worker can't run; wait for IB.
2. **Snapshot parse (X10.1)** — recent `eval_catalyst_stage1` `done` rows have **non-null `vol_multiple`** (not just `today_move_pct`). Null vol_multiple across the board ⇒ X10.1 regressed (volume field unparsed) or field 87 absent.
3. **Warmup (X10.1)** — `eval_catalyst_stage1` `failed` count with `last_error like '%missing price/open%'` is ~0 during RTH (the required-field warmup should prevent partial-snapshot fails).
4. **Advance flow (X10.2)** — `eval_catalyst_stage2` rows exist (`done` and/or drained) and `trait_scores(catalyst_reversal)` has rows with **today's `asof_date`**. Stage-1 done but no Stage-2/trait_scores after >~10min ⇒ advance loop not draining (X10.2 regressed).
5. **Surface** — Intraday/Swing virtual lists render catalyst chips for the scored names (FE; user confirms or screenshot).

### Verdict decision tree (the point of the batch)
- **Working** — checks 1-5 pass: catalyst names on the board. Close the catalyst track.
- **Working, no qualifiers today** — Stage-1 `done` with non-null `vol_multiple` + some `qualified:true`, but Stage-2's A∧B (beaten-down ∧ sudden-wakeup) legitimately filtered them → `trait_scores` empty. **Not a bug** — record it and re-check another RTH/day with more volatility.
- **Broken** — pinpoint the stage: null vol_multiple (→ X10.1), missing-price/open fails during RTH (→ warmup), Stage-1 done but no Stage-2/trait_scores (→ X10.2 advance), or trait_scores present but lists empty (→ FE `useVirtualList` join). File a follow-up naming the stage + evidence.

### Files this batch creates/edits
- None (verification only). Records outcome in `CLAIMS.md`; opens a follow-up batch only if broken.

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

## Batch 13.9: Finnhub call inventory + per-category cadence tuning

**Depends on:** none outstanding — all live Finnhub callers already exist via the shipped X-track. Ready to claim.

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

## Batch 16: UI/UX polish + a11y

**Depends on:** none outstanding (Batch 15 shipped).

**Scope:** Final pre-MVP user-facing sweep — loading/error/empty states, the shared global app header, mobile install guidance, accessibility. **PWA push removed (2026-06-08)** → `spec/roadmap.md` → Deferred from MVP → PWA push (gated behind the Alerts surface). **Engineering-quality work** (server DRY/SOLID, the 24-cron → shared base, perf, FE code dedup, test expansion) is **not** here — it lives in Batch ARCH so a refactor doesn't destabilize the MVP-milestone batch.

### Deliverables

1. **Loading states** for every async surface (initial portfolio load, chart load, analyze in progress, settings save).
2. **Error states**: BE unreachable, IB session stalled mid-action, Supabase Realtime disconnect with reconnect.
3. **Empty states** with helpful guidance (no positions: "Connect IB"; virtual lists not yet populated: helpful copy rather than a blank screen).
4. **Mobile install guidance**: a one-time tip on the Vercel landing screen explaining "Add to Home Screen" on iOS Safari.
5. **Accessibility pass**: keyboard focus order, screen-reader labels on icon buttons, color contrast ratios checked, motion-reduce honored. Tooltip semantics on the zone icon verified.
6. **Optional smoke tests** if `client/` test infra exists (vitest scaffold from earlier deferred batch).
7. **Shared global app header** — one header in the app shell (`App.tsx`, above `<Outlet>`) carrying the Upside logo · IB connection status · market-period badge · Alerts + Settings icons, present on **every** screen (today only Portfolio's `.ph-header` has the IB/market controls). Per-screen headers shrink to their own content (Watchlist title + glossary/gear; TickerDetail back + symbol) below the global bar. `useMarketSession()` already lives in the shell. See `spec/screens/_design-system.md` → Global app header + `spec/architecture.md` → Connection Status Header.

### Files this batch creates/edits
- Scattered touches across `client/src/`; for the header: a new `client/src/components/common/AppHeader.tsx` + `App.tsx` shell, trimming `PortfolioHome/Header.tsx`, `pages/Watchlist.tsx` header, `pages/TickerDetailPage.tsx` header.

### Verification
- Manual walkthrough: kill the BE, see graceful error UI on phone. Restart BE, see reconnect.
- Lighthouse audit on the Vercel URL: PWA install criteria met, accessibility score ≥ 90.

**🎯 Milestone: MVP per spec.**

---

## Batch X8: Signal Lab — measure / tune / explain the live signals

**Depends on:** the X1 forward-tracking backbone (shipped). Full design: `spec/signals/signal-lab.md`.

**Scope:** Signal-accuracy measurement applied to the **LLM-free engine signals that actually ship** (dip-bounce now; entry-zone / stats-band / marker / zone-entry once ported) — *not* the LLM analysis track (parked in `roadmap.md` → Track 4). Built on `signal_fires` / `signal_outcomes`; no parallel plumbing. **No pruning** — all fires/outcomes kept (cheap). Read-first: the lab measures and **recommends**; knob changes are recommend-then-approve, never auto-applied (v1).

### Deliverables

1. **Port the other live engines onto `signal_fires`** — entry-zone / stats-band / marker / zone-entry each write a fire row on trigger (the ping and the tracking row are one event). Scope/order TBD when claiming; the pattern is generic.
2. **Enrich `signal_fires.components`** from flat 0/1 → `{ fired, weight, added, why }` per rule, `why` snapshotting the raw engine values at fire time. Add `market_regime` column. Migration.
3. **Market-regime layer** — `regime_proxy` (SPY/QQQ/IWM/VIX) + `etf_constituents` (issuer-file membership, weekly cron; see `spec/data/sources.md` → ETF constituents) + `recommended_count`. SPY/QQQ/IWM ride the existing `daily_bars` pull; derive a regime label; stamp it on each fire. Migration.
4. **Effectiveness aggregation** (view/endpoint) — expectancy, lift over base rate, score-bucket calibration, **component attribution**, per-regime split, expired-without-hit, rolling 7/14d expectancy. Beyond the existing binary `signal_hit_rate_30d`.
5. **Knob editor with replay** — move scorer weights/thresholds from `config/dipBounceScorer.ts` into `signal_knobs` (Realtime; code = fallback). The lab proposes a change + **replays** past fires to show the would-be hit-rate/expectancy → user approves → write. Migration.
6. **Per-ticker keep/suppress** — `signal_suppressions`; the scorer cron skips a suppressed (conid, kind) once its fires show negative expectancy over enough samples. Migration.
7. **`signal_findings`** — durable conclusions at two grains (per-kind → reweight; per-(kind,conid) → keep/suppress). Migration.
8. **Explainability surfaces** — extract the pure scorer to a **shared module**; `useVirtualList` adds `intraday_stats` + `entry_zones` to its subscription and runs it per row so the live score + its Explain come from one recompute (never stale, no endpoint). Historical Explain drills into a stored fire. *(Whether to surface the score number on the row is TBD — decide once the virtual lists populate.)*

### Verification
- Component attribution query returns per-rule expectancy lift; score buckets sortable.
- A knob edit in `signal_knobs` takes effect on the next scorer tick; the replay matches.
- A suppressed (conid, kind) stops firing; un-suppressing resumes it.
- Live Explain on a row matches the displayed score and refreshes on quote tick.

### Open caveat
- The virtual lists currently aren't populating (no rows/fires observed) — confirm the dip-bounce producers are actually emitting fires before relying on accumulated data. The lab is only as useful as the fire stream feeding it.

---

## Batch ARCH: Architecture review + research sweep

**Depends on:** none. Best run after the MVP code has settled (post-15/16) but can start anytime.

**Scope:** A **research/review** batch, not an implementation batch. Audit the engineering-quality items pulled out of Batch 16 and produce prioritized findings + follow-up implementation batches — don't refactor in-place here.

### Deliverables (a findings doc + proposed follow-up batches)
1. **Cron architecture** — 24 crons (~4k lines) are hand-rolled `start*()` with per-file interval/locking/IB-gating/notify/compute-set logic. Evaluate a shared `defineCron({ name, intervalMs, lock, ibGated, run })` base for DRY **and stability** (one correct place for lock/retry/notify).
2. **Job/task triggering + preconditions (coverage)** — **Batch X10** builds per-action gate-and-defer and applies it to the catalyst bug (the concrete `requiresRthOpen` case). The architectural question for this review: across all 24 crons + the job queue, which *other* jobs silently fail or run on stale/absent inputs because they execute without checking their preconditions on trigger? Should the X10 gate model become the standard for every job that needs the session open / fresh data, and is the cron→task trigger wiring sound? Design reference: `spec/job-queue.md` → Per-action preconditions (gates).
3. **Server DRY/SOLID** — duplication across producers (the `curated ∪ watchlist ∪ held` compute-set, Finnhub/IB read patterns, Discord notify).
4. **Performance / loading times** — FE query waterfalls, Realtime reconnection, DB indexes, bundle.
5. **FE code polish** — component/hook dedup, dead code.
6. **Test gaps** — server + FE coverage beyond the X16 smoke tests.

### Output
- A markdown findings doc (committed) ranking each item by impact/risk, plus drafted follow-up batch entries for the ones worth doing. No production code change in this batch.
- **Review output produced (2026-06-10):** `docs/arch/server-architecture.html` (live-system map) + `docs/arch/target-architecture.md` (target model — ports/adapters, pure core, TableModules, scheduler — + refactor order). Follow-up implementation batches drafted there (ARCH-1 …).
- **Progress:** ARCH-1…8 shipped — **Phase 1 (TableModules) complete** + **Phase 2 (ports & adapters) complete**: ARCH-5 stood up the `HttpAdapter` base + `adapters/` root + the `polygon`/`yahoo` reference adapters + the `db/ → adapters/supabase/` relocation; ARCH-6 added `discord` (`notify.ts` → `Notifier`); ARCH-7 added `finnhub` (`FinnhubPort` + the `finnhubQueue` quirk; the hand-rolled metric/notify instrumentation landed on `HttpAdapter.instrumented()`); **ARCH-8 added `ib`** (the gateway HTTP half — `IbGatewayPort` + `IbGatewayAdapter`, the sole `env.ibGatewayUrl` reader, 20 callers rewired, `services/ibGateway.ts` deleted; 8a grew `instrumented()` with retry-counter/`detail`/`skipNotify`/`rawData`; `ibContainer`/`ibMappers`/`ibPassthroughAllowlist` stay put). `llm` deferred (roadmap Track 4). See `BUILD_QUEUE_DONE.md` + `docs/arch/target-architecture.md` → Phase 2. **Next claimable: ARCH-9 = Phase 3** — the `schedule()` / `defineCron({ name, intervalMs, lock, ibGated, run })` primitive (this batch's item 1): the ~24 hand-rolled `start*()` crons behind one base with one correct place for interval/lock/IB-gating/notify. Then **Phase 4** — relocate the pure core into `domain/` (`ibMappers`/`entryDeduction`/`ibPassthroughAllowlist`, the scorers, the pure signal logic). See `docs/arch/target-architecture.md`.

---

## Batch PROC: Agent discipline & skill-usage reliability + observability

**Depends on:** none. Design seed: [`docs/process/agent-discipline.md`](docs/process/agent-discipline.md).

**Scope:** A **research → design → implement** batch on the build *process itself* (not the product). Today the spec / batch / claim / skill protocol is all prose and honor-system — nothing enforces that the right skill fires at the right time, and a skipped step (an unwritten batch, a missed `finish-batch`, an unpersisted decision) surfaces only if a human notices. Make agent discipline **reliable** (invariants enforced at chokepoints), **observable** (a trail of which protocol steps ran / were skipped, surfaced to the user automatically), and **skill-correct** (`claim-batch` before code, `spec-edit` before any `spec/**` edit or persisted decision, `finish-batch` on completion, wrappers over raw tools). Design the keystone as a **config-driven, repo-agnostic** lib so it can spin off into its own GitHub repo + npm releases, with this repo as the first consumer.

### Pending decisions (settle with the user when claiming)
1. **Prevention vs. velocity** — keep direct-push-to-`dev` (CI *detects* + fast-revert) or move to PR-per-batch (CI *prevents*, unbypassable, but overturns "commit directly, no feature branches"). *Brief's recommendation:* keep direct-push + CI-detect + branch-protection force-push block.
2. **Bind whom** — both Claude + Cursor (weight in git hooks + CI) or mainly harden Claude's runs (`.claude/hooks/`). *Brief's recommendation:* both.

### Deliverables
1. **Finalize the design** in `docs/process/agent-discipline.md` — the invariant catalogue (claim-before-work, state-leak guard, commit grammar, doc-update exemption, the `table → module` grep manifest, skill-fired assertions) **with carve-outs** (doc-only diffs, `meta:`/`spec:` commits, handoffs, reclaims), and the lib/host config boundary.
2. **`bin/protocol-check`** (new, config-driven) — the single executable encoding the invariants; exits non-zero with a message on violation. Its own tests. Skills shrink to thin wrappers that call it.
3. **Layered enforcement** — versioned git hooks via `core.hooksPath` → `.githooks/` (`commit-msg` grammar + `pre-push` runs `protocol-check` + cheap gates); a GitHub Action (`.github/workflows/`) running `protocol-check` + typecheck + tests; Claude `PreToolUse`/`Stop` hooks (via `update-config`) as the fast Claude-only layer. `[MANUAL]` sub-item: GitHub branch-protection on `dev` (blocks force-push) — give the user the click-path, don't do it for them (`feedback_infra_handson`).
4. **Observability trail** — `protocol-check` (or a sibling) records which checks ran + verdicts; a session-end / `Stop`-hook summary floats skipped-but-expected steps to the user so an omission reports itself.
5. **Spinoff packaging** — extract the config-driven core behind a documented config schema + a versioning/release story; stand up the standalone repo + first npm release with Upside as consumer (can be a follow-up sub-batch once the in-repo version proves out).

### Files this batch creates/edits
- `docs/process/agent-discipline.md` (finalize), `bin/protocol-check` (+ tests), `.githooks/*`, `.github/workflows/*.yml`, `.claude/` hook config, thin updates to the skill bodies. A new external repo + npm package for the spinoff.

### Verification
- A deliberately-malformed commit (no claim, bad grammar, state leaked into `BUILD_QUEUE.md`, a `from('<table>')` outside its module) is caught by `protocol-check` locally and in CI; a legitimate doc-only / `meta:` commit passes (carve-outs hold).
- A skipped expected step (e.g. code committed with no matching claim) surfaces in the session-end / hook summary without a human hunting for it.
- `protocol-check` runs against a second toy repo via config alone (no Upside-specific hard-coding) — proves the spinoff boundary.

---

# Blocked / deferred

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

