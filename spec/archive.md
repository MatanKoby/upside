# Archive

Historical content not reflecting current code. Investigated-and-rejected approaches, dropped features, deprecated decisions. Read this when you wonder "why didn't we just do X?" — it answers that question without paying the token cost on every spec read.

Not deleted because the cost of accidentally forgetting institutional knowledge is asymmetric — easy to remove, painful to rediscover.

---

## IB Authentication — abandoned approaches

Four approaches tried before landing on on-demand IBeam. Documented here so the next agent doesn't redo them.

### (1) Programmatic credential POST to `/v1/api/iserver/auth/ssodh/init`

Attempted from `server/src/services/ibGateway.ts:ibLogin`. The gateway returned 401. That endpoint is for SSO redirection from the gateway's own UI, not direct password auth. Dead end at the protocol level — not a matter of getting the request shape right.

### (2) api-side path proxy `/ib-portal/*`

Implemented `http-proxy-middleware` proxying `/ib-portal/*` → `https://ib-gateway:5000/*`. Idea was to expose the gateway's login UI through the api's existing public tunnel without needing a second tunnel.

Failure: IB Gateway's served HTML returns absolute paths (`/sso/Login`, `/css/...`) which bypassed the `/ib-portal/` prefix and 404'd from the api router. Could be worked around with HTML rewriting but the maintenance burden of keeping that rewriter in sync with IB's UI changes was untenable.

### (3) Second dedicated Quick Tunnel to the gateway

Gave the gateway its own public origin so absolute paths worked. Browser-side login appeared to succeed ("Client login succeeds" message), but the gateway's `/v1/api/iserver/auth/status` from inside the compose network still returned 401.

Failure: cookie/Host-header round-tripping through Quick Tunnels does not carry the session cleanly. The Cloudflare proxy mangles or drops some cookie boundary the gateway depends on. Couldn't be debugged from inside the gateway (closed-source binary).

### (4) Full-time IBeam (auto-relogin)

Ran IBeam with default `IBEAM_RESTART_FAILED_SESSIONS=True`. Worked beautifully — until the user opened IBKR Mobile. Then:

1. IBKR Mobile claims the (one allowed) session, kicking IBeam out.
2. IBeam's restart loop logs back in within seconds, kicking IBKR Mobile out.
3. User can't use their phone app while Upside is deployed.

"Battle royale with IBKR Mobile." Unworkable in practice. Led to the current **on-demand IBeam** model where the user explicitly toggles connect/disconnect from the FE.

### (5) IBKR OAuth 1.0a Extended — parked, awaiting approval

The cleanest long-term answer: server-to-server auth, no gateway container needed, no credentials on the VPS, no session conflict with IBKR Mobile (OAuth uses a different session class). Implemented on the `oauth-dev` branch, commit `4d7a822`.

Blocked: requires IBKR-side activation that retail accounts must request explicitly via email. Days-to-weeks wait. Status check via support inquiry, no public timeline. Branch remains parked; ready to merge whenever approval lands.

---

## Pre-deployment landscape (Vercel FE first-deploy pitfalls)

These were the issues hit when first deploying the FE to Vercel (Batch 13). Documented because the resolution non-obvious and someone re-doing the deploy in a new environment will hit the same things:

- **Vercel uses Root Directory's `package.json`, not the workspace root's.** With Root Directory = `client`, Vercel reads `client/package.json` for `packageManager` / `engines`. We had to mirror both into `client/package.json` (they were only in the root).
- **Vercel ships pnpm 6.35.1 (from 2021) bundled.** Our pnpm-lock.yaml is v9.0 (pnpm 11). They're incompatible — pnpm 6 prints "Ignoring not compatible lockfile" and fails. The only clean fix is enabling Corepack via `ENABLE_EXPERIMENTAL_COREPACK=1` so the project's `packageManager: "pnpm@11.0.9"` is honored.
- **pnpm 11 requires Node ≥22.13** — set `engines.node: "22.x"` in `client/package.json` to match. Earlier tries set 20.x to dodge an unrelated `ERR_INVALID_THIS` bug that was actually pnpm-6-on-Node-24, not pnpm-11.
- **A stray `client/package-lock.json` is a deploy-blocker once Corepack is enabled** — Vercel sees it, concludes "the project uses npm," and refuses to mix npm + pnpm. Delete it.
- **Don't override Install / Build commands in Vercel UI or `vercel.json`** — declarative `package.json` (`packageManager` + `engines`) is sufficient and survives Vercel UI churn. No `vercel.json` needed for a Vite project.

---

## Wrong compose-image bug (Batch 7 discovery)

The original `docker-compose.yml` (Batch 5) referenced `ghcr.io/gnzsnz/ib-gateway-docker`. That image is the TWS Socket API gateway (ports 4001-4004), NOT the Client Portal REST gateway (port 5000) which our code actually targets. Different IB product, different auth flow, different protocol. Spec was correct from the start; the compose file was wrong.

Discovered during Batch 7's local-capture work. Fixed by commenting out the wrong service and later replacing it with `infra/clientportal.gw/Dockerfile` (Batch 10), which itself was later superseded by `voyz/ibeam:0.5.11` (Batch 13).

---

## Originally-dropped features (later revisited)

### BUY signals (originally dropped from MVP)

The original spec marked BUY signals as post-MVP, with rationale "BUY relates to entries/watchlist." Revisited post-Batch-13: the unified-analysis decision reinstated BUY signals as MVP scope. The LLM evaluates both directions on every Analyze call. BUY signals fire Discord notifications, accuracy-track, and render on TickerDetail in MVP. What's still deferred to Track 1 is the **Watchlists screen UI** — the place to browse them as a list.

### Push notifications (originally dropped from MVP)

The original spec dropped PWA push from MVP and replaced with Supabase Realtime (which only reaches users when the app is open). Revisited at Batch 16, which adds PWA push back via `web-push` library + VAPID keys, firing on the same triggers as Discord (zone-entry, signal-range-entry).

### Pre-market gap detection (replaced)

Originally planned as a separate cron. Replaced by continuous profit-taking zone detection — a gap that crosses the user's threshold fires the same notification as any other cause. Pre-market gap context is preserved as a "GAP" badge on TickerCards for the trading day, but no separate notification.

### Live tick-by-tick accuracy tracking (replaced)

Originally planned as a hook into pricePoller — update `actualMaxSinceAnalysis` / `actualMinSinceAnalysis` on every price tick. Replaced by daily hindsight cron (`accuracyUpdater`) that pulls today's intraday candles from Finnhub once at ~4:30 PM ET. Cheaper, IB-independent, sufficient granularity for evaluating signal quality empirically over weeks/months.

### `position_history` table (dropped)

Originally planned for daily snapshots. Never had a real consumer:
- MTD return comes from a Redis-cached month-start portfolio value, not from snapshots.
- Accuracy tracking lives on the `signals` row itself.

If post-MVP historical P&L charts ever need this, IB transactions API can rebuild the data on demand — no live retention required.

### Alpha Vantage (dropped)

Originally planned as a market-data source. Free tier limited to 25 calls/day — too restrictive. All technical indicators computed locally instead from IB price data using the `technicalindicators` npm library.

### Upstash Redis (dropped)

Originally planned as the Redis backend. Replaced by self-hosted Redis in a Docker container on the Oracle VPS. No external service dependency, no per-call quotas, runs free as part of the existing compose stack.

### Active Watchlist "approaching" threshold (dropped)

Briefly considered: Active Watchlist would include BUY signals where current price was within N% of the range (e.g. 5% below `priceRangeLow`). Dropped in favor of the two-container Live / Watching model — binary membership, no proximity math, no `active_watchlist_proximity_pct` setting needed. Cleaner.

### Bottom-nav: 4 tabs → 3 tabs (Watchlists track UI design)

Track 1 spec briefly described a 4-tab bottom nav (Portfolio · Watchlists · Alerts · Settings). Revised to 3 tabs (Portfolio · Watchlists · Settings) — Alerts is a bell icon in the header on each tab, not a bottom-nav destination. Bell icon scales to multiple screens (Portfolio + Watchlists both have it).

### Chat icon in MVP header (dropped)

Original spec had a chat icon button in the Portfolio header. Dropped entirely from MVP. May return post-post-MVP as a 4th bottom-nav tab or header affordance encompassing multiple LLM-driven features (see `roadmap.md` → Track 5).

---

## Architecture decisions superseded by reality

### "Real-time loop" was originally always-IB

Original spec described a single "real-time loop" polling IB every 5-15s. Worked when the assumption was that IB stayed connected 24/7. Once on-demand IBeam landed (Batch 13), positions stopped updating when the user disconnected IB to use IBKR Mobile.

Replaced with **multi-source price polling** — `ibPricePoller` (IB-only, runs when connected) + `finnhubPricePoller` (fallback, runs continuously, 60s cadence, only writes if IB hasn't within 90s). See `architecture.md` → Multi-source price polling.

### IB session token in Redis (no longer applicable)

The original spec described storing IB session tokens in Redis with 24h TTL. That model assumed Upside was driving login via credential POST (approach #1 above, abandoned). With IBeam doing browser-based login, the gateway holds the session internally — no token to extract. The api just polls `/v1/api/iserver/auth/status` and surfaces the result.

The Redis cache layer still exists for other things (market data cache, LLM call counter, MTD month-start snapshot) — just not for IB tokens.
