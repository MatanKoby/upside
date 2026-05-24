# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

### Batch 13.5 — Verify & implement `tradingDaysHeld` + MTD return
- Owner: claude
- Started: 2026-05-23
- Status note (2026-05-24, afternoon): SQL Editor verification surfaced TWO bugs in the entry-date path. Fixes written + typecheck-clean; awaiting deploy + re-verify.
  - **Verification finding:** only position is BBAI (conid 530965695). `first_seen_at`=2026-05-23 15:00 but `first_seen_source`='observed', `trading_days_held`/`daily_return`=null, despite IB being connected (`price_source`='ib', fresh). User confirms BBAI opened <90 days ago → `observed` is wrong; the IB-transactions exact date should have resolved.
  - **Bug 1 (self-lock):** `resolveEntryInfo` only attempted the transactions walk when `first_seen_at IS NULL`; one failed first attempt pinned the row to 'observed' forever. FIXED: re-attempts the upgrade hourly while source='observed', preserves the floor on failure, trusts 'ib_transactions' permanently.
  - **Bug 2 (HTTP 400 → 500 → warmup retry):** the lone Saturday `/pa/transactions` call was 400 (request-validation). Added `currency:'USD'` + `days` as string → after deploy the call became **500 with an empty body** (confirmed via psql metrics + `docker logs`: `[ibTransactions] conid=530965695 HTTP 500: ""`). Empty-body 500 = PortfolioAnalyst backend cold-start, not a bad request. FIXED (2nd pass): `ibTransactions` now retries up to 4× @1s through `instrumentedWithRetry` (same pattern as `ibSnapshot`), logging each non-2xx attempt. If it still 500s after 4 tries, falls back to 'observed' gracefully — and the spec explicitly allows the observed floor, so we don't over-invest if IB's PA endpoint stays flaky.
  - **Read-access RESOLVED (psql from WSL works):** root cause was the assumed pooler host. Project is on `aws-1-us-east-1.pooler.supabase.com` (not `aws-0-...`); username `upside_readonly.qkvegpfzstylyekmusnk`, session pooler :5432, sslmode=require. Confirmed read-only (writes → permission denied). `.upside-readonly-db` updated; how-to captured in the `query-supabase` skill. IPv6 path abandoned for real — host network provides no IPv6 (link-local only, no `::/0` route), so WSL mirrored mode has nothing to mirror; not WSL's fault. **claude now runs verification SQL directly via psql — no more SQL Editor pastes.**
  - **Next:** push fix to dev → user pulls on VPS + `./bin/upside rebuild api` + connects IB → after one IB poll cycle claude re-runs Query A via psql (expect source='ib_transactions', real <90d date, non-null days-held+daily_return) + metrics (expect new row 2xx). If still 4xx, `docker logs api | grep ibTransactions` shows IB's body.

  **Code state (commit 4cc5536, pushed to dev):**
  - Migration 007 (`first_seen_at` + `first_seen_source` on positions) — applied to Supabase ✓
  - ibGateway: `ibTransactions` (POST /v1/api/pa/transactions) + `deduceEntryDate` walker
  - ibPricePoller: `resolveEntryInfo` runs on first sight of a conid (or NULL `first_seen_at`), reconciles via IB transactions, falls back to `now()` + `source='observed'`. Computes `trading_days_held` + `daily_return` every cycle.
  - `marketHours.tradingDaysHeld`: weekday + US-holiday-aware day counter.
  - `services/mtdCache`: per-user Redis SET-NX anchor at first poll of each month (TTL 60d).
  - `/api/portfolio/summary` returns `mtdReturn` + `mtdReturnPercent` from the anchor, null when no anchor recorded yet.
  - FE: `PositionStatsDetail.daysHeldSource` + `dailyReturnPercent`; `PositionStats` renders "≥N days" + "≤X%/d" floor when source=observed, exact when source=ib_transactions. `usePortfolioSummary` hook polls /api/portfolio/summary + Realtime nudges; `SummaryStrip` handles null MTD with "—".
  - VPS deployed (user confirmed). IB connected (user confirmed). Polls should be running with the new fields.

  **Read-access setup — RESOLVED 2026-05-24:**
  - Dedicated read-only Postgres role `upside_readonly` (login+password+BYPASSRLS, SELECT-only on `public.*`), connect via `psql` from dev WSL. Connection string in `.upside-readonly-db` (gitignored). Operational how-to in the `query-supabase` skill.
  - **Root cause of "Tenant or user not found":** the pooler *host* was wrong, not the role. We assumed `aws-0-us-east-1.pooler.supabase.com`; the project is actually on `aws-1-us-east-1.pooler.supabase.com`. Same username (`upside_readonly.qkvegpfzstylyekmusnk`) + same password + correct host = connects fine on both :5432 (session) and :6543 (transaction). Lesson (per Supabase discussion #30107): never assume the pooler hostname pattern — copy it from the dashboard. Custom roles DO work through the pooler.
  - **IPv6 direct connection — dead, not pursued:** `db.<ref>.supabase.co` is IPv6-only; the host network provides no IPv6 at all (link-local only, no `::/0` route, IPv6 enabled in Windows but ISP/router doesn't hand it out), so WSL mirrored mode can't help. Moot now that the pooler (IPv4) works.

  **Verification queries — to write next session and have user run in SQL Editor:**
  ```
  select symbol, first_seen_at, first_seen_source, trading_days_held, daily_return, price_source, last_price_update_at from positions order by symbol;
  ```
  Plus a curl to `/api/portfolio/summary` (token-gated; user runs from terminal) to confirm `mtdAnchor` populated.
  Plus visual confirm in PWA that PositionStats shows days-held + return/day and SummaryStrip shows MTD.
  Then Finish protocol (task #8).

## Known issues (deferred fixes)

(none)

## Completed

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
