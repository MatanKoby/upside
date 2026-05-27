# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

### Batch 14g — Single-direction playbook engine
- Owner: claude
- Started: 2026-05-26
- **Design locked + spec written** (`signal-model.md` rewritten, `screens.md`/`flows.md` updated). Replaces the unified SELL+BUY analysis (14a) with a single-direction **playbook**. Scope for 14g (Fresh Analyze only):
  - **Direction by holding:** held → SELL playbook, not-held → BUY. MVP held-only → SELL today.
  - **Computed feature pack** (`technicals.ts`): pivots, swing highs/lows, N-day/52w highs/lows, ATR, SMA/EMA, RSI(+state), MACD(+cross), Bollinger(+%B/bandwidth), VWAP+distance, relative volume, position-relative distances. The LLM anchors legs to these levels — must not invent prices. (Biggest quality lever.)
  - **Playbook output** (Zod): `{ indicatorAnalysis, reasoning, signal: { direction, signalQuality, motivation, horizon: intraday|multiday, horizonWindow, legs:[{action, price, condition, confidence, reasoning}] } | null }`. Per-leg confidence; horizon-only timing (no per-leg timing).
  - **Persistence:** one `analyses` + **one** `signals` row; leg[0] → existing `price_range_*`/`optimal_price`; full legs+horizon → new `playbook jsonb`. Migration `010_playbook.sql` (also adds `analyses.refined_from_analysis_id` for 14h).
  - **Prompt:** single-direction, level-anchored, with `contextualTriggers.inProfitTakingZone` wired in (resolves the 14c-deferred prompt piece).
  - **FE:** render the playbook (legs + per-leg confidence + reasoning) in SignalSection; single pill on cards.
  - Expiry: intraday → end of session; multiday → window.
- Honesty caveats baked into spec: specific ≠ accurate (raises 14b's value); model strength matters (revisit provider later, not in 14g).
- **Implementation built + pushed (commits 8631379 code, ce6166f spec/schema).** Migration `010_playbook.sql` (signals.playbook jsonb + analyses.refined_from_analysis_id); `technicals.buildFeaturePack` (pivots / swing H-L / 20d+52w H-L / round magnets / ATR / SMA-EMA + price-vs-MA / structure / RSI+state / MACD+cross / Bollinger+%B+bandwidth / VWAP+distance / relative volume / position-relative); `llm.ts` direction-specific Zod + level-anchored single-direction prompt with zone trigger wired in; `signalEngine` rewritten (direction by holding, one analyses + one signals row, leg[0]→price_range_* via half-ATR band, horizon-driven expiry via new `marketHours.endOfRegularSessionEtIso`); FE SignalPill→single leg[0] price, SignalSection renders ordered legs (action·price/condition·confidence·why) under a horizon header (forward-compatible 14h status glyphs). Server+client typecheck + client build clean; `buildFeaturePack` runtime-checked on full/empty/3-bar inputs.
- **Pending before Completed:** (1) apply migration `010_playbook.sql` to Supabase; (2) `./bin/upside rebuild` on the VPS (FE auto-deploys via Vercel); (3) live walkthrough — tap Analyze on a held position, confirm a SELL playbook with ≥1 leg renders + a single pill on the card. Then move this entry to Completed.

### Batch 14h — Live leg tracking + Refine follow-up (planned, after 14g)
- Owner: claude (queued)
- **Half A:** pollers mark each active playbook leg `hit/missed/pending` + actual extreme on every price write (no LLM, no cron) → mechanical "on track / diverged"; feeds 14b.
- **Half B:** a second, manually-triggered **Refine** analyze mode — sends fresh feature pack + prior playbook + realized outcomes + anti-anchoring instruction → revised playbook; supersedes + records `refined_from_analysis_id`. Two buttons when an active signal exists (Refine / Re-analyze fresh).
- Deliberately split from 14g: validate base playbook quality on real tickers before building the refinement loop.

## Known issues (deferred fixes)

- **Signal quality poor → 14b + 14d deferred (2026-05-26)** — the unified SELL+BUY analyses we're getting are low quality. Hypothesis: the prompt asks for both directions at once, splitting the LLM's focus; switching to **single-direction** analysis (ask for SELL *or* BUY per run, not both) may sharpen them. Until signals improve there's no point measuring them, so **Batch 14b (accuracy cron) is deferred**, and **Batch 14d (signal-range pings) is deferred** with it. Revisit the single-direction redesign before un-deferring 14b/14d. (User call, 2026-05-26.)
- **TickerDetail loading/error states say "coming soon"** — `TickerDetailPage` reuses the `ComingSoon` placeholder for loading/error/not-held, so opening a position briefly shows "Loading SYMBOL… · SYMBOL — coming soon". Needs real skeleton/error/empty states. Folds into Batch 16 (loading/error/empty sweep). Spec: `screens.md` → Screen 2 note.
- **TickerDetail Indicators section empty** — `useTickerDetail` hardcodes `indicators: []`; the data exists on `analyses.indicator_snapshot` (Batch 14a) but isn't surfaced. Wants a future batch to render the latest analysis's indicators (incl. a pre-Analyze empty state). Spec: `screens.md` → Indicators note.

## Completed

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
- Notes: GET /api/debug/ib-passthrough proxies allowlisted read-only IB Client Portal paths and returns raw responses. Auth-gated (whitelisted email + Bearer); GET-only by route; positive regex allowlist; forbidden families documented (orders/, reply/, scanner/, place/cancel/modify). Logs to ib_api_metrics with debug-passthrough:<path> tag. Helper script bin/upside-ib calls it from the laptop — reads JWT from gitignored .upside-token, discovers api URL from Supabase, saves output to captures/<path>/latest.json + timestamped archive. Acceptance use-case completed: captured /v1/api/iserver/watchlists, /v1/api/iserver/watchlist?id=100, /v1/api/iserver/accounts. Schema findings for the future post-MVP Watchlist track captured back into UPSIDE_MVP_SPEC.md → "Track 1: Watchlists + BUY Signals" Data Model + Sync mechanism (system_lists-vs-user_lists filter, modified_at column, asset_class column, STK-only Analyze).

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
