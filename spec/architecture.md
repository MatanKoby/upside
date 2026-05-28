# Architecture

Upside's runtime shape: where things run, how they talk, who can sign in.

## Tech Stack
- **Frontend**: React (Vite) + TypeScript, PWA-enabled
- **Backend**: Node.js + Express, running on Oracle Cloud Always Free VPS
- **Database**: Supabase (PostgreSQL + Auth + Realtime) — free tier (500 MB DB, 50K MAUs)
- **Broker API**: IB Client Portal API (REST), gateway runs on same Oracle VPS
- **Market Data**: IB API (prices, OHLCV bars, fundamentals — VWAP computed BE-side, not provided by IB), Finnhub (news, sentiment, insider trades, earnings, intraday candles — free 60 calls/min, all routed through a rate-limited queue, see `schema.md`)
- **Technical Indicators**: Computed locally from IB price data using `technicalindicators` npm library (RSI, MACD, Bollinger, SMA/EMA, Stochastic, support/resistance, volume profile)
- **AI/LLM**: Multi-provider, provider-agnostic. **Current: Groq `llama-3.3-70b-versatile`** (free tier, proven) via an OpenAI-compatible provider; **Mistral** configured but not yet used; OpenRouter / OpenAI available the same way. **Gemini** (native REST) is implemented but parked — its free tier was too rate-limited for even a single analysis; may revisit on a paid tier. Active provider/model chosen at **runtime** via `app_config` + `/api/config/llm` (Settings dropdown) — keys live in `.env`, no restart to switch. No vendor lock-in. See `signals/playbook.md` → LLM Provider Abstraction.
- **Caching**: Redis (self-hosted in Docker container on Oracle VPS — no external service)
- **Hosting**: Vercel (frontend, free *.vercel.app subdomain), Oracle Cloud (backend + IB gateway + Redis, free)
- **CI/CD**: GitHub (PUBLIC repo, proper secret isolation) + manual deploy initially, GitHub Actions later
- **Auth**: Google OAuth via Supabase Auth + hard-coded email whitelist (invite-only for MVP)
- **Total monthly cost**: $0 (Groq free tier; Mistral free tier available). Upgrade path: ~$5-10/mo if switching to a paid Claude/OpenAI tier.

## Infrastructure — Oracle Cloud VPS (US-Ashburn)

Oracle Cloud Always Free: 4 ARM OCPUs, 24 GB RAM, 200 GB storage. Docker Compose runs 4 containers:

1. **IBeam** (`voyz/ibeam:0.5.11`) — wraps the IB Client Portal Gateway and automates its browser-based login. Exposes the gateway REST API on the compose-network hostname `ib-gateway:5000` (HTTPS, self-signed cert) — same name + protocol as the bare gateway, so the api code is unchanged. Reads IBKR credentials from `/run/secrets/ib_account` and `/run/secrets/ib_password` (files mounted in from VPS host, see "IB Authentication Flow"). The custom `infra/clientportal.gw/Dockerfile` is kept as a fallback if IBeam ever stops being maintained, but not used in the live stack.
2. **Upside Node.js app** (`api`) — Express + cron jobs + signal engine + tunnel watcher. The brain.
3. **Redis** — local caching for IB rate-limit buffering and data deduplication.
4. **cloudflared** — Cloudflare Quick Tunnel exposing the api container over HTTPS. Runs with `--no-autoupdate` so the tunnel URL stays stable across cloudflared image updates (we trigger updates explicitly). Writes its startup log to a shared volume; the api's tunnel watcher reads it and upserts the URL into `app_config.api_url`.

All 4 containers communicate via Docker internal bridge network (`upside`).

**Single-user MVP scope**: one user, one IB account. Multi-user (e.g., separate accounts for family members) requires a per-user `ib-gateway` container — the IB Client Portal Gateway is single-session, so two users cannot share one gateway. Tunnel and watcher do **not** multiply with users: the api is the single public entry point and proxies to the appropriate internal `ib-gateway-N` based on user. Deferred post-MVP.

## Architecture pattern

Monolith Node.js app with external integrations — NOT microservices. Single Node.js process handles: API endpoints, WebSocket connections, IB gateway communication, signal engine, Finnhub/LLM calls. IB Gateway is a separate container only because it's IB's Java software with its own lifecycle. Can decompose later if needed (e.g., Python ML service), but unnecessary for MVP.

## Public URL Discovery (self-healing Quick Tunnel)

The api container is exposed to the public internet via Cloudflare Quick Tunnel (free, no custom domain required). Quick Tunnel URLs are random `*.trycloudflare.com` hostnames assigned at cloudflared process startup. They change whenever the cloudflared process restarts. Rather than pin that URL into Vercel env vars (which would force manual intervention after each restart), the system self-heals via Supabase as a runtime config store.

**Why this pattern instead of a paid domain + named tunnel:** the $10/yr domain is the simpler answer to "stable public URL," but with self-healing in place we get zero ongoing maintenance at zero cost. Estimated restart frequency in practice is 1-3 per year (Oracle VPS reboots + rare cloudflared crashes), each fully automatic from the user's perspective. The mechanism stays in place harmlessly if we later attach a domain — the URL just stops changing, watcher becomes a no-op.

**Components:**

- **`cloudflared` compose service** — `cloudflared tunnel --no-autoupdate --url http://api:3001 --logfile /shared/cloudflared.log`. `--no-autoupdate` is critical: without it, cloudflared self-updates ~daily and each update reassigns the Quick Tunnel URL.
- **`app_config` Supabase table** (see `schema.md`) — key/value runtime config holding `api_url`. RLS: public `select`, service-role `insert`/`update`/`delete`. Realtime enabled.
- **Tunnel watcher (in api)** — background task `server/src/services/tunnelWatcher.ts`. Watches the cloudflared logfile (`fs.watch` + 30s poll fallback), parses the current Quick Tunnel URL, upserts into `app_config.api_url`. In-process inside the api because the supabase service-role client is already there.
- **FE bootstrap** — on app load the FE reads `api_url` from `app_config` (cache-first via localStorage, stale-while-revalidate), then subscribes via Supabase Realtime so URL changes propagate within ~500ms. There is **no** `VITE_API_URL` Vercel env var — Supabase is the single source of truth.

**Recovery flow on tunnel restart:** cloudflared restarts → new Quick Tunnel URL assigned (~5-10s) → watcher detects → upserts `app_config` (<1s) → Supabase Realtime fires `UPDATE` → FE swaps cached URL (<500ms). Total user-visible outage: **~10-15 seconds**.

**First deploy:** start the VPS stack *before* deploying Vercel FE. By the time the FE first loads, `app_config.api_url` is already populated.

## Upside Authentication (Google OAuth + Whitelist)

- Single login button on entry: "Continue with Google"
- Uses Supabase Auth with Google OAuth provider
- After Google OAuth returns, backend checks email against whitelist (env var `UPSIDE_ALLOWED_EMAILS`, comma-separated)
- Whitelisted → JWT issued, lasts 30+ days, lands on portfolio home (or IB connect if first time)
- Not whitelisted → log attempt to `access_attempts` table, sign out, redirect to https://google.com (inconspicuous bounce)
- No public signup form — emails added to whitelist out-of-band by admin
- **Multiple whitelisted emails are allowed at the auth layer** (any whitelisted user can sign in). However, **pricePoller serves only the *first* whitelisted user's data** in MVP — additional users can sign in but see no data until multi-user architecture lands post-MVP (per-user `ib-gateway` container).
- No password-based fallback in MVP (Google OAuth only)
- Login page has no Upside branding visible until after auth succeeds

## IB Authentication Flow

- **Account requirement**: IBKR **Pro** account, fully funded and activated. Client Portal Web API is not supported on IBKR Lite. Real-time market data subscription required for live prices.
- **On-demand login via IBeam** — IB Client Portal Gateway only accepts authentication through its own web UI. IBeam wraps the gateway and drives browser-based login via a headless browser. The api treats IBeam exactly like the bare gateway: same `ib-gateway:5000` hostname, same Client Portal REST endpoints.
- **Critical constraint: IBKR allows only one active session per account.** If the user opens IBKR Mobile while IBeam holds a session, IBeam gets kicked out — and IBeam's default maintenance loop would re-login immediately, kicking IBKR Mobile out, ad infinitum. To respect the user's primary use of IBKR Mobile, **IBeam is off by default**:
  - `ib-gateway` is tagged with `profiles: [manual]` in `docker-compose.yml` so `docker compose up -d` does **not** start it.
  - `IBEAM_RESTART_FAILED_SESSIONS=False` and `IBEAM_AUTHENTICATION_STRATEGY=A` (less aggressive) so even when running, IBeam doesn't fight to re-claim the session.
  - User explicitly turns IBeam on/off from the Upside FE.
- **Connect / Disconnect controls in the FE**: small status indicator in the header shows IB state (`stopped` / `connecting` / `connected` / `disconnected`). Tap to connect when stopped, tap to disconnect when connected.
  - **Connect**: FE POSTs `/api/auth/ib/connect` → the api uses its Docker-socket access to issue a Docker `start` on the `ib-gateway` container → IBeam boots, logs in (~15-25s), triggers a 2FA push to the user's IB Key app → user approves → gateway authenticated (~5s later). FE shows "Approve 2FA push on IB Key app" during this window and polls `/api/auth/status` every ~3s.
  - **Disconnect**: FE POSTs `/api/auth/ib/disconnect` → api issues Docker `stop` on `ib-gateway` → container exits in ~2-5s → IBKR Mobile is free to use.
- **Cached-first portfolio display**: the FE shows portfolio positions from Supabase regardless of whether IB is currently connected. When connected, `ibPricePoller` writes fresh data. When IB is disconnected, the Finnhub fallback poller keeps `current_price` reasonably fresh (see "Multi-source price polling"). The status indicator's color tells the user how fresh data is. **No full-screen "session expired" takeover.**
- **Docker socket access**: the api container has `/var/run/docker.sock` mounted read-write. Full Docker control on host — accepted security trade-off for single-user self-hosted MVP. If exposed multi-tenant, this needs to change (e.g., privileged "control" sidecar with start/stop allowlist).
- **Credentials** live in two files on the VPS at `~/upside/secrets/ib_account.txt` and `~/upside/secrets/ib_password.txt`, mode `0400`, owner `ubuntu`. IBeam mounts them read-only at `/run/secrets/`; reads them via `IBEAM_SECRETS_SOURCE=fs`. Gitignored. Credentials never in env vars, in `docker-compose.yml`, or in any committed code.
- **No Redis token storage for IB session** — when running, IBeam/Gateway hold the session internally; the api just polls `/v1/api/iserver/auth/status`.
- Multi-device support: IB session shared across all user's devices (both pull from same Supabase state).
- Session keepalive via `/v1/api/tickle` every 30s.
- IB's nightly forced logout (~11:45 PM ET) ends session daily — user must Connect again next day.
- On session expiry: status indicator turns red. UI does NOT full-screen takeover — portfolio remains visible from Supabase cache, Finnhub fallback keeps prices reasonably fresh. User taps status indicator to reconnect.
- If IB session is killed externally (user logged into TWS directly), next backend poll detects auth error → marks expired → status indicator turns red.

Abandoned approaches (kept in `archive.md` so the next agent doesn't redo them): programmatic credential POST, api-side path proxy, second Quick Tunnel to gateway, full-time IBeam, OAuth 1.0a Extended (parked on `oauth-dev` branch awaiting IBKR approval).

## Connection Status Header

- Always-visible status dot in header next to market period badge.
- Green dot → connected (no text).
- Amber dot + "Reconnecting..." → mid-session retry in progress.
- Red dot + "Session expired" → user action required.

## Multi-source price polling (IB primary, Finnhub fallback)

The "real-time loop" is implemented as two cooperating pollers writing to the same `positions` row:

- **Primary (`ibPricePoller`)**: runs only when IB session is `connected`. Adaptive cadence (10s / 60s / 5min depending on market period). Writes to Supabase with `price_source: 'ib'` and stamps `last_price_update_at`. Best granularity, requires IB connected.
- **Fallback (`finnhubPricePoller`)**: runs continuously, 60s cadence, but **skips the whole tick while the IB session is authenticated+connected** — IB is authoritative for all held positions when live, so Finnhub must not write. (The earlier per-row "older than 90s" staleness check was leaky: `ibPricePoller`'s change-detection skips the write *and* the `last_price_update_at` bump when a price holds steady, so a quiet IB price would "expire" after 90s and Finnhub would overwrite it with its delayed quote — e.g. pre-market IB 4.28 vs Finnhub prior-close 4.18 — causing a price/total flicker. Gating on IB connection status fixes that.) When IB is down, it fetches a quote via `finnhubQueue.request('quote', symbol, ...)` for each held position older than 90s and writes with `price_source: 'finnhub'`. Note Finnhub free `/quote` carries no extended-hours price, so the fallback shows the prior close pre/post-market.

Both pollers recompute zone state on every write (see `signals/zone.md`). The FE renders `current_price` agnostic to source.

**Watchlist coverage (post-watchlist-pivot, Batch A1):** the polling loop's symbol set is `held_conids ∪ active_watchlist_conids` — the union of held positions and tickers in `watchlist_lists WHERE active=true`. Same cadence, same IB-primary/Finnhub-fallback semantics. Writes land in `quotes` (canonical), and `positions` (denormalized for held). Hidden watchlists are not polled. Discord channels extend correspondingly: `#upside-zone-profit` (held), `#upside-dip-buys` (watchlist markers + entry zones — see `signals/markers.md` and `signals/entry-zones.md`).

**Why this works:** matches the on-demand IBeam model. Prices update in Supabase even when the user has IB disconnected to use IBKR Mobile. Zone notifications and signal-range notifications keep firing. The user gets a working app whether or not IB is currently up; IB just makes things sharper.

## Single source of truth for current price

**Principle:** price is a property of an *instrument*, not a holding. There is one canonical "latest quote" per conid, written by one ingestion loop (the pollers above), read by every consumer — they do **not** re-fetch their own.

**Today (MVP, held-only):** canonical = `positions.current_price` (+ `last_price_update_at`, `price_source`). Consumers that must read it instead of re-fetching: the TickerDetail header (already does, via Realtime), the chart's live-price line, the Today's-Range dot, and `signalEngine` — gated on `last_price_update_at` recency (see `signals/playbook.md` → Freshness guard).

**Track 1 (watchlists, post-MVP):** the canonical is promoted to a dedicated **`quotes`** table keyed by `conid` (see `schema.md`). `positions` and `watchlist_items` reference it; neither carries a duplicated `price` column. The pollers' loop extends to cover every tracked conid (held + watchlisted). One writer, one price per instrument, all surfaces read the same value. The table stores **both** IB and Finnhub prices side-by-side (each with its own timestamp) so divergence is observable and fallback is made on real provenance — not by silently overwriting one source with the other.

**Origin (2026-05-27):** a 14g live test exposed `signalEngine` overriding the poller's fresh value with its own cold IB snapshot (returning the prior close right after Connect), producing three BBAI analyses stuck at ~$4.17 while live was $4.37. The fix is structural — one writer, all readers — not a patch on the snapshot path.

## Three Loops in the Node.js app

1. **Multi-source price polling** (continuous): `ibPricePoller` (IB-only, adaptive cadence) + `finnhubPricePoller` (fallback, 60s, skips entirely while IB is connected). Both recompute zone state on each write and trigger zone/signal-range Discord notifications inline.
2. **Daily hindsight accuracy cron** (`accuracyUpdater`, once daily at ~4:30 PM ET): for each non-superseded signal in last 30 days, pull today's intraday candles from Finnhub, update `actualMaxSinceAnalysis` / `actualMinSinceAnalysis`, stamp `enteredRangeAt` / `exitedRangeAt`. IB-independent.
3. **Keepalive loop** (every few hours): Supabase ping + IB session tickle (when connected).

Signal generation is **user-triggered only** in MVP — no automated scanning cron. Automated scanning is post-MVP, paired with PWA push notifications.

## Supabase Keepalive

Backend pings Supabase with a lightweight query every few hours to prevent 7-day inactivity pause. Not an issue with daily trading, but insurance for vacations/breaks.

## Security

This spec is public. The repo is public. Security comes from proper secret isolation, authentication, and database access controls — NOT obscurity. Anyone reading this spec gains no advantage in attacking the system.

### What MUST NEVER be committed to the repo

- `.env` files (use `.env.example` with placeholder values only)
- Any API keys: Gemini, Finnhub, Anthropic, OpenAI, Supabase service key
- IB account credentials (username, password, account number)
- Whitelisted Gmail addresses
- The Oracle VPS public IP address
- Custom domain names (if any used)
- Supabase project URL or anon key
- Any IB session tokens or auth cookies
- Database dumps, backups, or actual user data
- Screenshots showing real positions, real portfolio values, or real signal data (use mock data for screenshots)

### What MUST be enforced

- `.gitignore` includes `.env`, `.env.local`, `.env.production`, `*.pem`, `*.key`, `secrets/`, `node_modules/`, build artifacts
- GitHub secret scanning enabled (default for public repos) — auto-detects accidentally committed API keys
- All secrets via environment variables on the Oracle VPS (`docker-compose` reads from `.env` file that's NOT committed)
- Supabase Row Level Security (RLS) policies enforced on every user-data table
- IB credentials stored in mode-0400 files on VPS — never in app code, server config, or database
- Google OAuth + email whitelist for Upside auth, with rejected attempts logged to `access_attempts` table
- Rate limiting on all public endpoints (login, OAuth callback)
- HTTPS only. Frontend served by Vercel (automatic TLS on `*.vercel.app`). Backend exposed via Cloudflare Tunnel — automatic HTTPS, requires no domain purchase, no incoming firewall port forwarding.
- Dependency audit (`npm audit`) before any deploy
- Secrets rotated if ever exposed accidentally — assume compromise

### Repo visibility

- Spec repo: PUBLIC (this file)
- Code repo: PUBLIC (proper secret isolation assumed)
- Both public is acceptable; the security model assumes hostile reading

## MVP Build Order

> **Operational sequencing lives in `BUILD_QUEUE.md`** (repo root). The Sprint outline below is a planning ladder describing what gets built and roughly when. The actual execution unit is the **batch**, tracked in `BUILD_QUEUE.md`, with per-batch claims in `CLAIMS.md`. When the two disagree, the queue wins. The "data-only live" milestone (phone shows real portfolio + auth working, no signals yet) was reached at Batch 13.

### Sprint 1 — Get data on screen (~1 week)
1. IB gateway + Node.js API proxy on Oracle VPS
2. Portfolio home screen with real IB position data (static initially)
3. Supabase setup + Google OAuth auth + email whitelist

### Sprint 2 — Make it live (~1 week)
4. Real-time price updates (multi-source: IB primary, Finnhub fallback)
5. Sparklines (7-day daily closes) + P&L tint intensity
6. VWAP computed BE-side from intraday bars (IB doesn't expose VWAP as a snapshot field; `server/src/services/technicals.ts:vwap()`)
7. Sort views (P&L, custom drag)
8. Ticker detail screen

### Sprint 3 — Add intelligence (~2 weeks)
9. Signal analysis engine — manual trigger only, **unified SELL + BUY analysis per call**. Both directions persisted; BUY signals accumulate even though dedicated Watchlists screen waits for Track 1 (see `roadmap.md`).
10. Signal pills on TickerCards (range-based; pill carries type + quality + motivation + range)
11. Signal detail view (Style A analytical breakdown — shared indicators header + per-direction blocks)
12. Signal history per ticker
13. Analysis lock pattern (concurrent-safe via Supabase Realtime)
14. Profit-taking zone detection with Discord notifications

### Sprint 4 — Polish (~1 week)
15. Alerts feed screen
16. Settings screen (MVP scope: IB connection, signal preferences, theme, LLM provider, profit-zone threshold)
17. PWA push notifications (same triggers as Discord)
18. Multi-device sync via Supabase as source of truth

### Out of MVP — DROPPED

- ❌ Watchlists screen + tab strip + Active Watchlist UI — first thing post-MVP (Track 1). **BUY signals themselves DO ship in MVP** (unified analysis produces both directions); they just don't have a dedicated screen until Track 1.
- ❌ Automated signal scanning / cron-based analysis
- ❌ Alpha Vantage (all technicals computed locally)
- ❌ Upstash Redis external (self-hosted in Docker)
- ❌ IBeam / automated IB login at boot — superseded by **on-demand IBeam**.
- ❌ Pre-market gap detection as a separate cron — replaced by continuous profit-taking zone detection. Pre-market gap context preserved as a UI badge on cards for the day.
- ❌ Live tick-by-tick accuracy tracking — replaced by daily hindsight cron from Finnhub intraday candles.
- ❌ `position_history` table — never had a real consumer; MTD comes from Redis cache, accuracy lives on `signals`.

## Project Structure (Recommended)

```
upside/
├── client/                 # React frontend (Vite) — deploys to Vercel
│   ├── src/
│   │   ├── components/
│   │   │   ├── primitives/                   # Atomic UI renderers (catalog in screens/_design-system.md)
│   │   │   ├── PortfolioHome/
│   │   │   │   ├── TickerCard.tsx            # variant='held'|'watchlist'
│   │   │   │   ├── SummaryStrip.tsx
│   │   │   │   ├── SortBar.tsx
│   │   │   │   └── MarketPeriodBadge.tsx
│   │   │   ├── TickerDetail/
│   │   │   │   ├── TickerDetail.tsx
│   │   │   │   ├── TodayRange.tsx
│   │   │   │   ├── MarketStats.tsx
│   │   │   │   ├── ChartControls.tsx
│   │   │   │   ├── PriceChart.tsx
│   │   │   │   ├── TimeframeBar.tsx
│   │   │   │   ├── SignalSection.tsx
│   │   │   │   ├── PositionStats.tsx
│   │   │   │   └── IndicatorsSection.tsx
│   │   │   ├── Watchlists/                   # POST-MVP Track 1
│   │   │   ├── AlertsFeed/
│   │   │   ├── Settings/
│   │   │   │   └── IBLoginFlow.tsx
│   │   │   └── common/
│   │   │       ├── CollapsibleSection.tsx
│   │   │       └── Tooltip.tsx
│   │   ├── hooks/
│   │   ├── services/
│   │   │   ├── supabase.ts
│   │   │   ├── api.ts                        # REST calls (URL from apiUrl.ts)
│   │   │   └── apiUrl.ts                     # public URL discovery
│   │   ├── types/
│   │   ├── utils/
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   │   ├── manifest.json
│   │   └── service-worker.js                 # added in Batch 16
│   └── index.html
├── server/                 # Node.js backend — runs in Docker on Oracle VPS
│   ├── src/
│   │   ├── routes/
│   │   │   ├── portfolio.ts
│   │   │   ├── marketdata.ts
│   │   │   ├── signals.ts                    # incl. /accuracy
│   │   │   ├── auth.ts                       # IB + Google OAuth
│   │   │   ├── user.ts                       # preferences PUT/GET
│   │   │   └── health.ts                     # deep /healthz
│   │   ├── services/
│   │   │   ├── ibGateway.ts
│   │   │   ├── ibMappers.ts
│   │   │   ├── finnhub.ts
│   │   │   ├── finnhubQueue.ts               # see schema.md
│   │   │   ├── signalEngine.ts
│   │   │   ├── technicals.ts
│   │   │   ├── llm.ts
│   │   │   ├── discord.ts                    # multi-channel notifier
│   │   │   ├── webPush.ts                    # PWA push (Batch 16)
│   │   │   ├── redis.ts
│   │   │   ├── supabase.ts
│   │   │   └── tunnelWatcher.ts
│   │   ├── scripts/
│   │   │   └── captureIb.ts                  # one-shot capture (Batch 7)
│   │   ├── cron/
│   │   │   ├── ibPricePoller.ts
│   │   │   ├── finnhubPricePoller.ts
│   │   │   ├── accuracyUpdater.ts
│   │   │   ├── lockCleanup.ts
│   │   │   └── keepalive.ts
│   │   ├── middleware/
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
├── infra/
│   └── clientportal.gw/      # Fallback Dockerfile (not used in live stack)
├── supabase/
│   └── migrations/
├── captures/                 # Raw IB JSON dumps (gitignored, Batch 7)
├── secrets/                  # IB credential files (gitignored)
├── spec/                     # this directory
├── docker-compose.yml        # 4 services: ib-gateway (IBeam, on-demand), api, redis, cloudflared
├── .env.example
├── BUILD_QUEUE.md
├── CLAIMS.md
├── AGENTS.md
├── CLAUDE.md
├── package.json
└── README.md
```

The full catalog of FE primitives is in `screens/_design-system.md`.
