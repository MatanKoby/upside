# Batch Claims

Agent-managed batch state for both Claude Code and Cursor. **Do not put claim fields inside `BUILD_QUEUE.md`** — that file is user-owned and gets pasted over when the user adds or revises batches, which would wipe any state stored in it.

This file is the single source of truth for *who is working on what* and *what has been completed*. `BUILD_QUEUE.md` defines *what to build*; `CLAIMS.md` records *what has happened*.

See `AGENTS.md` for the full claim / finish / handoff / reclaim protocols.

## In progress

(none)

## Known issues (deferred fixes)

(none)

## Completed

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
