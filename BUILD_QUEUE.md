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

> **Pick-order pointer for "continue".** The screener track (S0.3 / S0.5 / S1 / S1.5 / S2 / S3), the dip-bounce track (X1–X3 + X6), the risk-flags track (R1 / R2), the **daily_bars layer (X4)** and the **price SSOT (X5)** have all shipped — see `BUILD_QUEUE_DONE.md` + `CLAIMS_DONE.md`. **Remaining un-done**, rough priority: **X7** (news-as-signal — design settled 2026-06-07, **in progress**, see `CLAIMS.md`) · **Batch C remainder** (per-marker cooldown UI, `at_or_above` channel routing, stats-alert second trigger) · **Batch 15** (alerts feed + settings) · **Batch 14h** (live per-leg tracking + Refine — also tracked in `CLAIMS.md` → In progress) · **Batch 13.9** (Finnhub cadence tuning) · **Batch 16** (PWA push + remaining polish). **Blocked / deferred:** 13.3 (waiting on IBKR support reply re secondary-user market-data cost), 14b + 14d (deferred behind LLM signal-quality sharpening). When the user types "continue" after a context clear, **ask** which un-done batch to claim.

---

## Batch X7: News-as-signal (design settled 2026-06-07)

**Depends on:** Finnhub `companyNews` (already wired). Full design: `spec/signals/news-signal.md`.

**Decisions settled with user (2026-06-07):**
- **Shape = risk-flags modifier**, not a universe trait (no bulk news endpoint → runs over held ∪ watchlist ∪ curated only).
- **Scoring = LM-inspired finance lexicon** over `companyNews` headlines/summaries. Finnhub `/news-sentiment` probed → **403 premium** (dead, delete it); LLM scoring deferred.
- New **`news_sentiment` SSOT table** consumed by (1) the risk-flags engine → `bad_news` WARNING flag, (2) `useVirtualList` → news chip + good/bad rank nudge. 48h decay window.

**Deliverables:**
1. Migration `031_news_sentiment.sql` (table + index + Realtime + grants).
2. `services/news/` — `lexicon.ts` (weighted neg/pos term sets + severe tier) + `scoreNews.ts` (pure, tested scorer → `{ score, label, article_count, top_headline, top_url }`).
3. `cron/newsSentimentCron.ts` — held ∪ watchlist ∪ curated; per-ticker `companyNews(48h)` → score → upsert `news_sentiment`. **Not** IB-gated.
4. Risk-flags wiring: `RiskFlagKey += 'bad_news'`, `RiskFlagConfig.newsBearishScore` (default −0.35), optional `RiskFlagInputs.newsScore`, the raise in `computeRiskFlags`; `riskFlagsCron` reads `news_sentiment.score`, `signalEngine` scores its already-pulled `news`.
5. FE: `client/src/utils/riskFlags.ts` `bad_news` labels; `useVirtualList` + `config/virtualList.ts` news rank term + chip; `VirtualListRow.tsx` + CSS.
6. Delete dead `newsSentiment()` from `finnhub.ts`.

**Files this batch creates/edits:** `supabase/migrations/031_*`, `server/src/services/news/*`, `server/src/cron/newsSentimentCron.ts`, `server/src/services/finnhub.ts`, `server/src/services/riskFlags/{inputs,computeRiskFlags}.ts`, `server/src/config/riskFlags.ts`, `server/src/services/signalEngine.ts`, `server/src/cron/riskFlagsCron.ts`, `server/src/index.ts`, `client/src/utils/riskFlags.ts`, `client/src/hooks/useVirtualList.ts`, `client/src/config/virtualList.ts`, `client/src/components/Watchlist/VirtualListRow.tsx`, `client/src/styles/components.css`.

**⚠️ Migration to run:** `031_news_sentiment.sql` (additive — no ordering constraint with code deploy).

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

6. **`PUT /api/user/preferences`** — BE endpoint validates + upserts the user_preferences row. FE writes through this rather than directly to Supabase to keep validation centralized. *(Note: a GET/PUT `/api/user/preferences` route already shipped in Batch R2 for `risk_flag_config`; Batch 15 extends it to the rest of the prefs rather than building it fresh.)*

### Files this batch creates/edits
- `client/src/pages/Alerts.tsx`, `client/src/pages/Settings.tsx`, `client/src/components/AlertsFeed/*`, `client/src/components/Settings/*`, `client/src/hooks/useUserPreferences.ts`, `client/src/routes.tsx`, `server/src/routes/user.ts` (extend the existing preferences route).

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

---

## Batch 14b: Daily hindsight accuracy tracking cron

**DEFERRED (2026-05-26):** signal quality is currently poor, so measuring accuracy is premature. The single-direction rework happened as **Batch 14g** (single-direction playbook engine + computed feature pack) → **14h** (live per-leg tracking + Refine). 14h's live tracking is the per-leg accuracy foundation; revisit/un-defer this hindsight cron once 14g/14h land and base quality is confirmed. Full design in `spec/signals/playbook.md`; scope in `CLAIMS.md`.

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

## Batch 14d: Signal-range Discord notifications (SELL + BUY)

**DEFERRED (2026-05-26):** deferred alongside Batch 14b until signal quality improves (see the 14b note + `CLAIMS.md` → Known issues). The zone-entry notifications in 14c still ship; this is specifically the *signal-range* pings. **Note (2026-06):** the dip-bounce track (X1) shipped a generic `signal_fires`/`signal_outcomes` backbone with two suggestion channels — when this un-defers, port it onto that backbone rather than building parallel range-check plumbing.

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
