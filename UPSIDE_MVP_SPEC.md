# Upside — MVP Product Specification

## Overview

Upside is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. It displays your IB portfolio positions with real-time data, AI-powered signals (sell windows, entry points, event alerts), and contextual insights. Built for a solo intraday/swing trader on NYSE/NASDAQ, phone-first usage, 24/7 availability.

---

## Security

This spec is public. The repo is public. Security comes from proper secret isolation, authentication, and database access controls — NOT obscurity. Anyone reading this spec gains no advantage in attacking the system.

### What MUST NEVER be committed to the repo:
- `.env` files (use `.env.example` with placeholder values only)
- Any API keys: Gemini, Finnhub, Anthropic, OpenAI, Supabase service key
- IB account credentials (username, password, account number)
- Whitelisted Gmail addresses for access control
- The Oracle VPS public IP address
- Custom domain names (if any used)
- Supabase project URL or anon key
- Any IB session tokens or auth cookies
- Database dumps, backups, or actual user data
- Screenshots showing real positions, real portfolio values, or real signal data (use mock data for screenshots)

### What MUST be enforced:
- `.gitignore` includes `.env`, `.env.local`, `.env.production`, `*.pem`, `*.key`, `secrets/`, `node_modules/`, build artifacts
- GitHub secret scanning enabled (default for public repos) — auto-detects accidentally committed API keys
- All secrets via environment variables on the Oracle VPS (`docker-compose` reads from `.env` file that's NOT committed)
- Supabase Row Level Security (RLS) policies enforced on every user-data table
- IB credentials stored ONLY in user's browser password manager — never in app code, server config, or database
- IB session tokens stored ONLY in Redis with 24h TTL — never persisted to disk or DB
- Google OAuth + email whitelist for Upside auth, with rejected attempts logged to `access_attempts` table
- Rate limiting on all public endpoints (login, OAuth callback)
- HTTPS only. Frontend served by Vercel (automatic TLS on `*.vercel.app`). Backend exposed via **Cloudflare Tunnel** — `cloudflared` runs on the Oracle VPS, exposes the api container, provides automatic HTTPS, requires no domain purchase, no incoming firewall port forwarding.
- Dependency audit (`npm audit`) before any deploy
- Secrets rotated if ever exposed accidentally — assume compromise

### Repo visibility:
- Spec repo: PUBLIC (this file)
- Code repo: PUBLIC (proper secret isolation assumed)
- Both public is acceptable; the security model assumes hostile reading

---

## Architecture

### Tech Stack
- **Frontend**: React (Vite) + TypeScript, PWA-enabled
- **Backend**: Node.js + Express (or Fastify), running on Oracle Cloud Always Free VPS
- **Database**: Supabase (PostgreSQL + Auth + Realtime) — free tier (500 MB DB, 50K MAUs)
- **Broker API**: IB Client Portal API (REST), gateway runs on same Oracle VPS
- **Market Data**: IB API (prices, OHLCV bars, fundamentals — VWAP is computed BE-side, not provided by IB), Finnhub (news, sentiment, insider trades, earnings — free 60 calls/min)
- **Technical Indicators**: Computed locally from IB price data using `technicalindicators` npm library (RSI, MACD, Bollinger, SMA/EMA, Stochastic, support/resistance, volume profile)
- **AI/LLM**: Gemini free tier via Google AI Studio (initially). Provider-agnostic abstraction layer — swap to Claude/OpenAI via env var. No vendor lock-in.
- **Caching**: Redis (self-hosted in Docker container on Oracle VPS — no external service)
- **Hosting**: Vercel (frontend, free *.vercel.app subdomain), Oracle Cloud (backend + IB gateway + Redis, free)
- **CI/CD**: GitHub (PUBLIC repo, proper secret isolation) + manual deploy initially, GitHub Actions later
- **Auth**: Google OAuth via Supabase Auth + hard-coded email whitelist (invite-only for MVP)
- **Total monthly cost**: $0 (Gemini free tier). Upgrade path: ~$5-10/mo if switching to Claude API.

### Infrastructure — Oracle Cloud VPS (US-Ashburn)
- Oracle Cloud Always Free: 4 ARM OCPUs, 24 GB RAM, 200 GB storage
- Docker Compose runs 4 containers:
  1. **IB Client Portal Gateway** (Java) — IB's software, exposes REST API on the compose-network hostname `ib-gateway:5000` (HTTPS, self-signed cert). Built locally from IB's official `clientportal.gw.zip` via `infra/clientportal.gw/Dockerfile`. **Requires an IBKR Pro account** — Client Portal Web API is not supported on IBKR Lite.
  2. **Upside Node.js app** (Express + WebSocket + cron jobs + signal engine + tunnel watcher) — the brain
  3. **Redis** — local caching for IB rate-limit buffering and data deduplication
  4. **cloudflared** — Cloudflare Tunnel agent (Quick Tunnel mode) that exposes the api container over HTTPS without opening firewall ports or requiring a custom domain. Runs with `--no-autoupdate` so the tunnel URL stays stable across cloudflared image updates (we trigger updates explicitly). Writes its startup log to a volume shared with the api so the tunnel watcher can detect URL changes. See "Public URL Discovery" below for the self-healing pattern.
- All 4 containers communicate via Docker internal bridge network (`upside`)
- **Single-user MVP scope**: one user, one IB account. Multi-user (e.g., separate accounts for family members) requires a per-user `ib-gateway` container — the IB Client Portal Gateway is single-session, so two users cannot share one gateway. The tunnel and watcher do **not** multiply with users: the api is the single public entry point and proxies to the appropriate internal `ib-gateway-N` based on user. Deferred post-MVP.

### Public URL Discovery (self-healing Quick Tunnel)

The api container is exposed to the public internet via Cloudflare Quick Tunnel (free, no custom domain required). Quick Tunnel URLs are random `*.trycloudflare.com` hostnames assigned at cloudflared process startup. They change whenever the cloudflared process restarts. Rather than pin that URL into Vercel env vars (which would force manual intervention after each restart), the system self-heals via Supabase as a runtime config store.

**Why this pattern instead of a paid domain + named tunnel:** the $10/yr domain is the simpler answer to "stable public URL," but with self-healing in place we get zero ongoing maintenance at zero cost. Estimated restart frequency in practice is 1-3 per year (Oracle VPS reboots + rare cloudflared crashes), each fully automatic from the user's perspective. The mechanism stays in place harmlessly if we later attach a domain — the URL just stops changing, watcher becomes a no-op.

**Components:**

- **`cloudflared` compose service** — runs `cloudflared tunnel --no-autoupdate --url http://api:3001 --logfile /shared/cloudflared.log`. `--no-autoupdate` is critical: without it, cloudflared self-updates ~daily and each update reassigns the Quick Tunnel URL. We update the image explicitly when we choose to.
- **`app_config` Supabase table** — key/value runtime config: `{ key: text primary key, value: text not null, updated_at: timestamptz default now() }`. RLS: public `select`, service-role `insert`/`update`/`delete`. Realtime enabled. Holds `api_url` for now; designed as a generic runtime-config home for future flags.
- **Tunnel watcher (in api)** — background task in `server/src/services/tunnelWatcher.ts`. On startup and on log-file change (`fs.watch` + 30s poll fallback), parses cloudflared's "Your quick Tunnel ... <URL>" line and upserts the current URL into `app_config` keyed `api_url`. In-process inside the api rather than a sidecar, because the supabase service-role client is already there — duplicating it to a sidecar broadens the secret surface for no real lifecycle benefit (if api is down, the URL update wouldn't help anyone).
- **FE bootstrap** — on app load the FE reads `api_url` from `app_config` (cache-first via localStorage, stale-while-revalidate), then subscribes via Supabase Realtime so URL changes propagate within ~500ms without polling. All API calls go to the discovered URL. There is **no** `VITE_API_URL` Vercel env var — Supabase is the single source of truth.

**Recovery flow on tunnel restart:**
1. cloudflared restarts; new Quick Tunnel URL assigned (~5-10s).
2. Watcher detects new log line; upserts `app_config` (<1s).
3. Supabase Realtime fires `UPDATE`; FE swaps cached URL (<500ms).
4. Next FE API request hits the new URL.

Total user-visible outage on a planned restart: **~10-15 seconds**.

**First deploy:** start the VPS stack (cloudflared writes URL → watcher upserts to Supabase) *before* deploying Vercel FE. By the time the FE first loads, `app_config.api_url` is already populated. No manual env-var step.

**Verification (used in Batch 11):**

```bash
# Terminal 1 — watch the watcher detect the URL change
docker compose logs api -f | grep -i tunnel

# Terminal 2 — trigger a restart
docker compose restart cloudflared

# Then:
#  - Supabase SQL Editor: select * from app_config; — verify new URL within ~15s
#  - Browser dev tools (FE open): first request fails, next succeeds against new URL
```

### IB Authentication Flow
### Upside Authentication (Google OAuth + Whitelist)
- Single login button on entry: "Continue with Google"
- Uses Supabase Auth with Google OAuth provider
- After Google OAuth returns, backend checks email against whitelist (env var `UPSIDE_ALLOWED_EMAILS`, comma-separated)
- Whitelisted → JWT issued, lasts 30+ days, lands on portfolio home (or IB connect if first time)
- Not whitelisted → log attempt to `access_attempts` table (`{ email, ip_address, user_agent, attempted_at }`), sign out, redirect to https://google.com (inconspicuous bounce)
- No public signup form — emails are added to whitelist out-of-band by admin
- **Multiple whitelisted emails are allowed at the auth layer** (any whitelisted user can sign in and access the app). However, **pricePoller serves only the *first* whitelisted user's data** in MVP — i.e. positions are polled from the IB account tied to whichever Supabase user matched the first email in `UPSIDE_ALLOWED_EMAILS`. Additional users can sign in but will see no data until the multi-user architecture lands post-MVP (per-user `ib-gateway` container).
- No password-based fallback in MVP (Google OAuth only)
- Login page has no Upside branding visible until after auth succeeds

### IB Authentication Flow
- **Account requirement**: IBKR **Pro** account, fully funded and activated. Client Portal Web API is not supported on IBKR Lite. Real-time market data subscription required for live prices (delayed otherwise).
- **Browser-mediated login via reverse proxy** — IB Client Portal Gateway only accepts authentication through its own web UI (programmatic credential POSTs return 401, discovered during Batch 13). The api container proxies a path prefix `/ib-portal/*` to `https://ib-gateway:5000/*` so that:
  - User enters IB credentials directly into IB's own login UI rendered through the proxy.
  - Credentials never touch our code — they flow browser → reverse proxy → gateway → IB servers.
  - 2FA push fires to IB Key phone app → user approves with biometrics → gateway holds the session.
  - Our BE polls `/v1/api/iserver/auth/status` (server-to-server) and surfaces the result via `/api/auth/status` to the FE.
- **FE renders the proxy in an iframe** by default so the login stays inside the Upside PWA. If X-Frame-Options / CSP frame-ancestors from the gateway block iframe embedding (despite our proxy stripping them), the FE falls back to opening the proxy URL in a new tab.
- **No Redis token storage in the BE for IB session** — IB Gateway maintains its own session cookie/state internally; we just ask it whether it's authenticated. (The Redis-stored token plan from earlier batches no longer applies; that assumed a programmatic-auth model we cannot use.)
- Multi-device support: IB session shared across all user's devices (both pull from same Redis-stored session)
- Session keepalive via tickle endpoint every 30s
- IB's nightly forced logout (~11:45 PM ET) ends session daily
- On session expiry: full-screen block with "Reconnect" prompt (no cached data shown until restored)
- On mid-session failure (IB hiccup): silent retry with exponential backoff, header status dot turns amber. If all retries fail, dot turns red, user can tap to reconnect via non-blocking side sheet.
- Backend stops polling when session expires — no unnecessary API calls
- If IB session is killed externally (user logged into TWS directly), next backend poll detects auth error → marks expired → all clients see block screen

### Connection Status Header
- Always-visible status dot in header next to market period badge
- Green dot → connected (no text)
- Amber dot + "Reconnecting..." → mid-session retry in progress
- Red dot + "Session expired" → user action required

### Signal Model (MVP — SELL signals on held positions only)

**Trigger:** Manual only. Two-step intentional friction:
1. User taps "Analyze" on ticker detail
2. Button greys out for 1 second
3. Button shows "Confirm analyze" — user taps again to confirm
4. Analysis runs (~5-15 seconds)

**Concurrency lock (Supabase + Realtime):**
- `analysis_locks` table with row per active analysis: `{ symbol, user_id, started_at, status }`
- Supabase Realtime broadcasts lock to all connected clients → Analyze button disabled everywhere
- On completion (success or error), lock row deleted → button re-enables, new signal appears via Realtime
- Stale locks (>60s old) auto-cleaned by cron

**Pre-LLM filters (skip analysis entirely):**
- Skip positions with market value < $1,000 (configurable threshold)
- Skip positions where user has manually disabled signal generation
- DROPPED for MVP: "skip positions opened recently" filter (manual trigger means user controls timing)

**Signal structure (range-based, not point-based):**
- Engine outputs SELL with a **price range** (e.g. $193-198) and **optimal price** (the HIGH of range, since selling high = better)
- Signal is dormant until live price enters range
- Client renders SELL badge when current price ≥ range low
- **Two confidence metrics shown separately:**
  - Signal Quality (0-100, LLM's confidence in the analysis — stable per signal)
  - Price Proximity ("at optimal" / "approaching optimal" / "edge of range" — computed from live price)
- Compact card shows: "Sell · 82% · $193–198 (target $198)"

**No-signal as valid output:**
- LLM can return `signalType: 'no_signal'` with a reason ("Indicators mixed: RSI overbought but volume increasing, earnings in 2 days adds uncertainty")
- Stored like any other signal, visible in history

**Multiple signals per analysis:**
- One analysis can produce 1 or 2 signal records (e.g. sell + buy when both make sense)
- In MVP, only SELL is supported, so this is effectively always 1 signal

**Re-analysis behavior:**
- Re-analyzing creates a new signal record; old signal marked `supersededByAnalysisId`
- Old signal remains in history, never deleted
- Latest signal shown on ticker detail by default with "Last analyzed: 3h ago · N previous analyses"
- Signal History collapsible section shows full chronological list of past analyses for this ticker

**Accuracy tracking (continuous, per signal):**
- For each SELL signal: track `actualMaxSinceAnalysis` — highest price observed since signal generated
- For each BUY signal (post-MVP): track `actualMinSinceAnalysis` — lowest price observed
- Updated on every price tick during market hours
- Stored in signal record for post-MVP accuracy view

**Info badges (non-signal context, shown on cards):**
- Earnings date proximity (e.g. "Earnings · 12d")
- Upcoming dividend dates
- Insider transactions (size/direction)
- Unusual volume (today vs 30d avg)
- Material news (sentiment-flagged via Finnhub)
- Analyst rating changes
- Extreme social sentiment (very positive or very negative)
- All shown in one row on compact card, trading signals shown FIRST, info badges AFTER

### Realtime Update Architecture (no push notifications in MVP)
- All clients subscribe to Supabase Realtime on `positions`, `signals`, `analysis_locks` tables
- Backend writes to Supabase → Realtime pushes change notification to clients → clients pull latest data from Supabase (source of truth)
- Push notifications DROPPED from MVP — Realtime handles online users. Offline users see updates when they next open the app.
- Push notifications return post-MVP when automated signal scanning is added (user might be alerted when not in app)

### Supabase Schema (tables)
- `positions` — current holdings per user, written by `pricePoller`, read via Realtime by the FE
- `signals` — range-based signal records per analysis (range, indicators, reasoning, accuracy tracking)
- `user_preferences` — sort order, theme, LLM provider, signal threshold, suppressed symbols
- `analysis_locks` — concurrency control for signal analysis
- `access_attempts` — Google OAuth attempts (granted + non-whitelisted)
- `contracts` — per-conid metadata cache (company_name, industry, category, currency, exchange). Populated lazily; weekly refresh
- `ib_api_metrics` — per-IB-call instrumentation (endpoint, duration_ms, retries, status). 30-day TTL. Foundation for empirical perf tuning
- `app_config` — key/value runtime config (`{ key, value, updated_at }`). Currently holds `api_url` (current Cloudflare Quick Tunnel URL, written by the tunnel watcher; read by the FE on bootstrap and via Realtime subscription). Public read via RLS, service-role write only. See "Public URL Discovery" in Architecture for the self-healing mechanism. Designed as a generic home for future runtime flags too.
- `position_history` — **DROPPED from MVP**. Originally planned for daily snapshots; not needed because MTD comes from IB account summary and accuracy tracking lives on the signals row itself. Re-add when we want historical P&L charts.

### LLM Provider Abstraction
- Provider-agnostic interface in backend: `analyzePosition(context: PositionContext) → Signal`
- Implementations: `gemini.ts` (default for MVP — free tier), `claude.ts`, `openai.ts` (upgrade paths)
- Selected via `LLM_PROVIDER` env var (`gemini` | `claude` | `openai`)
- Switching providers requires backend restart

### Signal Data Sources (per analysis)
- IB price data: real-time + intraday + historical daily bars + pre-market data
- Computed locally: RSI, MACD, Bollinger, VWAP (from intraday bars; IB doesn't ship it), VWAP divergence, support/resistance, volume profile, SMA/EMA, Stochastic
- Finnhub: news, sentiment scores, insider transactions, earnings calendar
- LLM picks the timeframe (intraday, swing, longer) based on what the data suggests
- Reasoning output includes short bullet per contributing indicator + overall summary

### Data Sources (simplified)
- **IB API provides**: real-time prices (subscribe-then-poll snapshot), OHLCV bars (any interval/timeframe), volume, historical data (20+ years), fundamentals (P/E, EPS, market cap, beta, 52-week range), position/account data, transactions, account summary (incl. MTD return).
- **Computed locally from IB data**: RSI, MACD, Bollinger Bands, SMA/EMA, Stochastic, support/resistance, volume profile, **VWAP** (IB's snapshot endpoint does NOT expose VWAP as a field; we compute it from intraday history bars in `server/src/services/technicals.ts`), VWAP divergence, **`tradingDaysHeld`** (intended source: IB's transactions endpoint — find entry date for each held position, count trading days since. **⚠ Verification pending at Batch 9 implementation**: confirm the transactions endpoint exists, returns the data we need, and is reliable for all positions. Fallback if not: track entry-date in Upside from when we first see a position, accept that pre-Upside positions show 0 until next user-confirmed entry).
- **From IB account summary**: month-to-date (MTD) return — intended source is `/v1/api/portfolio/<acctId>/summary` or equivalent (**⚠ Verification pending at Batch 9 implementation**: confirm endpoint name and response shape for MTD field). Fallback if missing: compute from a lightweight position-value-at-month-start snapshot kept in Redis.
- **Finnhub provides**: company news + sentiment scores, insider transactions, earnings calendar + estimates, basic financials (supplementary)
- **Alpha Vantage**: DROPPED — 25 calls/day too limiting, all technicals computed locally instead
- **Sparklines**: fetched live from IB (7 daily bars per ticker), current day updates in real-time. No overnight batch needed.

### IB API Rate Limits
- Global: 10 requests/second via Client Portal API
- Historical data: no hard limit for bars ≥1 min, but soft pacing — avoid >60 requests/10 min
- With <10 positions, rate limits are not a concern. Redis cache prevents redundant calls.

### Supabase Keepalive
- Backend pings Supabase with a lightweight query every few hours to prevent 7-day inactivity pause
- Not an issue with daily trading, but insurance for vacations/breaks

### Architecture Pattern
- NOT microservices — monolith Node.js app with external integrations
- Single Node.js process handles: API endpoints, WebSocket connections, IB gateway communication, signal engine cron, Finnhub/LLM calls
- IB Gateway is a separate container only because it's IB's Java software with its own lifecycle
- Can decompose later if needed (e.g., Python ML service), but unnecessary for MVP

### Three Loops in the Node.js App
1. **Real-time loop** (every 5-15s during market hours): Poll IB → cache in Redis → write to Supabase → Supabase Realtime pushes to client
2. **Signal loop** (every 15-30 min during market hours): For each eligible position → fetch IB bars → compute technicals → fetch Finnhub news → send to LLM → write signal to Supabase → client pulls on Realtime notification → push notification if above threshold
3. **Keepalive loop** (every few hours): Supabase ping + IB session tickle

---

## MVP Build Order

> **Operational sequencing lives in `BUILD_QUEUE.md`.** The Sprint outline below is a planning ladder describing what gets built and roughly in what phase. The actual execution unit is the **batch**, tracked in `BUILD_QUEUE.md`, with per-batch claims in `CLAIMS.md`. When the two disagree, the queue wins. The "data-only live" milestone (phone shows real portfolio + auth working, no signals yet) is reached after Batch 13 in the queue.

### Sprint 1 — Get data on screen (~1 week)
1. IB gateway + Node.js API proxy on Oracle VPS
2. Portfolio home screen with real IB position data (static initially)
3. Supabase setup + Google OAuth auth + email whitelist

### Sprint 2 — Make it live (~1 week)
4. Real-time price updates (WebSocket/polling from IB, all sessions)
5. Sparklines (7-day daily closes) + P&L tint intensity
6. VWAP computed BE-side from intraday bars (IB doesn't expose VWAP as a snapshot field; `server/src/services/technicals.ts:vwap()`)
7. Sort views (P&L, custom drag)
8. Ticker detail screen

### Sprint 3 — Add intelligence (~2 weeks)
9. Signal analysis engine — manual trigger only, SELL signals on held positions
10. Signal pills on position cards (range-based, fired when live price in range)
11. Signal detail view (Style A analytical breakdown)
12. Signal history per ticker
13. Analysis lock pattern (concurrent-safe via Supabase Realtime)

### Sprint 4 — Polish (~1 week)
14. Alerts feed screen (Positions only in MVP)
15. Settings screen (MVP scope: IB connection, signal preferences, theme, LLM provider)
16. Multi-device sync via shared IB session in Redis

### Out of MVP — DROPPED
- ❌ Push notifications (Supabase Realtime handles online users; users not in app don't need urgent alerts in MVP)
- ❌ Watchlists (regular and active) — first thing post-MVP
- ❌ BUY signals (only SELL signals in MVP since BUY relates to entries/watchlist)
- ❌ Automated signal scanning / cron-based analysis
- ❌ Alpha Vantage (all technicals computed locally)
- ❌ Upstash Redis external (self-hosted in Docker)
- ❌ IBeam / automated IB login (manual via browser autofill)

### Post-MVP (in priority order)
1. Active Watchlist (BUY signals on whatever ticker)
2. Regular Watchlists (read-only mirror from IB)
3. Push notifications (when automated scanning is added)
4. AI chat (conversational portfolio Q&A)
5. Natural language ticker screener
6. Trade journal with %/day metric
7. Signal accuracy tracking view (aggregated stats from per-signal accuracy data)
8. Options / shorts / trade execution

---

## Screen Specifications

### Screen 1: Portfolio Home

This is the main screen. Mobile-first, phone-sized (375-390px viewport).

#### Header
- Top-left: "Upside" logo text (18px, weight 500)
- Top-right: Market period badge (tappable dropdown)
  - Shows colored dot + current period: "Pre-market", "Regular", "After-hours", "Closed"
  - Dot colors: amber (pre-market), green (regular), blue (after-hours), gray (closed)
  - Tapping opens dropdown showing exchange groups and their trading windows:
    - NYSE / NASDAQ: Pre-market 4:00–9:30 AM ET, Regular 9:30 AM–4:00 PM ET, After-hours 4:00–8:00 PM ET
    - (Future: LSE, TSE, etc.)
- Header also has icon buttons: notifications (ti-bell, taps into Alerts feed — Screen 3 — which renders an empty state until signals start firing), settings (ti-settings, taps into Settings — Screen 4). Chat icon dropped from MVP.

#### Summary Strip
Two metric cards side by side:
- Left: "Portfolio value" label (11px, muted) + value in large text (18px, weight 500)
- Right: "MTD return" label + value with percent in parentheses, colored green/red, e.g. "+$2,148 (+4.7%)"

#### Sort Bar
Three pill-shaped toggles:
- "Signals" — sort by signal urgency (highest confidence actionable signals on top)
- "P&L" — sort by unrealized P&L descending (biggest gains on top)
- "Custom" — user-defined drag-to-reorder, stored in Supabase per user
Active pill: filled dark background, white text. Inactive: outlined, muted text.

#### Position Cards
Each card represents one held position. Layout per card:

```
┌──────────────────────────────────────────────┐
│ NVDA          +$3,240 (+18.2%)  ▁▂▃▄▅  $140.40 │
│ NVIDIA Corp                          +$1.82 (+1.3%) │
│                                      ↑ +0.8% VWAP │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ (portfolio weight bar) │
├──────────────────────────────────────────────┤
│ [Sell · 82%] Resistance $141 + RSI 74, exit 1–3d  > │
└──────────────────────────────────────────────┘
```

**Left column (~78px min):**
- Ticker symbol (14px, weight 500, primary color)
- Company name (10px, tertiary color, truncated with ellipsis at ~76px)

**Center area (flex):**
- Unrealized P&L combined: `+$3,240 (+18.2%)` — dollars first, percent in brackets (13px, weight 500)
  - Green for gain, red for loss, gray for near-zero (threshold: ±1%)
- Sparkline (44x20px inline SVG) — 7-day price shape
  - Green stroke for uptrend, red for downtrend, gray for flat
  - No axes, no labels, just the polyline shape

**Right column (~72px min, right-aligned):**
- Current price (14px, weight 500, primary color)
- Today's change: `+$1.82 (+1.3%)` (10px, colored green/red independently from total P&L)
- VWAP comparison (10px): arrow icon + percentage vs VWAP
  - Green up-arrow + "+0.8% VWAP" = price above VWAP (bullish)
  - Red down-arrow + "-1.2% VWAP" = price below VWAP (bearish)
  - "= VWAP" in gray when essentially flat (threshold: ±0.1%)

**Portfolio weight bar:**
- Horizontal bar at the bottom of the card, inside the card
- Starts from the left edge
- Width = position's percentage of total portfolio value
- Very subtle opacity — acts as background visual indicator
- Color matches the P&L tint (green for gain, red for loss, gray for near-zero)

**Background tint:**
- Subtle background color tint on the entire card
- Green tint for positive P&L, red tint for negative P&L, gray tint for near-zero
- Tint INTENSITY scales with P&L magnitude:
  - 0-1%: gray, opacity ~0.04
  - 1-5%: green/red, opacity ~0.05
  - 5-10%: opacity ~0.07
  - 10-20%: opacity ~0.10
  - 20%+: opacity ~0.14

**Signal row (conditional — only shown when a signal exists):**
- Separated by a thin border-top (0.5px)
- Signal pill badge: `[Sell · 82%]`, `[Add · 71%]`, `[Earnings · 12d]`
  - Sell pill: red background, dark red text
  - Buy/Add pill: green background, dark green text
  - Event pill: blue background, dark blue text
  - Watch pill: amber background, dark amber text
- Short signal summary text (11px, secondary color)
- Chevron-right arrow at far right indicating tap-to-expand
- Tapping opens the Signal Detail view (Style A)

**Cards without signals** have no signal row — clean, compact card.

#### Bottom Navigation Bar
Four tabs with icons + labels:
- Portfolio (ti-chart-pie) — active
- Screener (ti-search) — post-MVP, can show "coming soon"
- Chat (ti-message-chatbot) — post-MVP
- Alerts (ti-bell)

---

### Screen 2: Ticker Detail

Opens as a full-screen slide-in from the right when tapping a position card. Route: `/ticker/:symbol`

> **Held vs. unheld tickers render the same screen.** Every TickerDetail screen has the same layout: header, today's range, market stats, chart, controls, timeframe bar, collapsible sections. The only difference between a position you hold and one you don't is that **Position Stats** section is present for held positions (shares, avg cost, P&L, contribution, days held) and absent for non-held. Everything else — signal section, market stats, chart, indicators — renders identically regardless.

#### Navigation
- Slide-in animation from right (CSS transform)
- Back arrow (ti-arrow-left) returns to portfolio home

#### Header
- Left: back arrow + ticker symbol (18px, weight 500) + company name (11px, muted)
- Right: current price (18px, weight 500) + today's change in $ and % (12px, colored)

#### Today's Range (above chart)
- Label: "Today's range" (left) + "Open $139.20" (right, muted)
- Visual range bar: horizontal track with colored dot showing current price position
- Low price in red (left), high price in green (right)
- Blue dot position = (currentPrice - dayLow) / (dayHigh - dayLow) * 100%

#### Market Stats (above chart, below today's range)
Dense, customizable stats panel:
- Two rows of four stats each, very compact layout
- Each stat: tiny label (10px, muted) + value (11px, weight 500)
- Row 1 default: Vol | P/E | Prev close | Beta
- Row 2 default: Open | EPS | MktCap | AvgVol
- 52-week range bar below stat rows (smaller version of today's range bar)
  - Dot position = (currentPrice - fiftyTwoWeekLow) / (fiftyTwoWeekHigh - fiftyTwoWeekLow) * 100%
- "Edit" link (top-right of section) opens inline customization panel:
  - Separated into "Visible" and "Hidden" groups
  - Each stat: drag handle (ti-grip-vertical) for reordering + toggle switch for visibility
  - Available stats pool: Volume, Forward P/E, Prior close, Beta, 52-week range, Open, EPS, Market cap, Dividend amount, Dividend date, Put/call interest, Put/call volume, Tweet volume, Avg volume (30d)
  - User's stat selection/order persisted (local state initially, Supabase later)

#### Chart Controls (between stats and chart)
- Left side: Line / Candle toggle buttons
- Right side: VWAP / Vol / RSI indicator toggle buttons
- Small pill-style buttons, active state = filled

#### Price Chart
- Library: Lightweight Charts by TradingView (free, open source)
- Candlestick mode and line mode, toggled by chart controls
- Entry price: horizontal dashed amber line at user's avg cost basis, labeled "Avg $XX.XX"
- Entry date: vertical dashed amber marker at purchase date, labeled "Entry [date]"
- VWAP overlay: purple line, toggleable
- Volume bars: at bottom of main chart area, subtle gray, toggleable
- RSI subchart: separate pane below main chart, toggleable
  - Overbought zone (>70) shaded faintly red
  - Oversold zone (<30) shaded faintly green
  - Current RSI value displayed
- Touch-friendly: pinch to zoom, drag to pan
- Dark mode compatible

#### Timeframe Bar (below chart)
- Horizontally scrollable pills: 30m, 2h, 1D, 2D, 1W, 1M, 3M, 1Y, 5Y, All
- Active pill = filled dark, inactive = outlined muted

#### Below-Chart Sections (all collapsible, using shared CollapsibleSection component)

**Signal Section** (only if active signal exists):
- Icon: ti-alert-triangle (colored by signal type)
- Header: signal type + confidence (e.g. "Sell · 82%")
- Body contains:
  - Signal summary text (1-2 sentences)
  - "Full signal breakdown" expandable section
  - Full breakdown (Style A):
    - Confidence bar (0-100%, colored fill)
    - Timeframe: "3-7 days" / "Intraday" / "1-2 weeks"
    - Target price range: "$136-138"
    - Risk/reward ratio: "1:2.4"
    - Indicator table: each row = Indicator name | Current value | Status badge (Bullish green / Bearish red / Neutral gray)
    - Summary count: "5 of 6 indicators bearish"
    - AI reasoning: 2-3 sentence explanation citing specific data points
    - "Ask about this signal" button → post-MVP hook for AI chat

**Position Stats:**
- Icon: ti-wallet
- Header: shows total unrealized P&L as right-side value (colored)
- Body rows:
  - Shares held
  - Avg cost basis
  - Current value
  - Unrealized P&L ($ and %)
  - Today's change ($ and %)
  - Return per day: totalPnlPercent / tradingDaysHeld → displayed as "+0.79%/day"
  - Portfolio weight: positionValue / totalPortfolioValue → "44.0%"
  - Portfolio contribution: positionPnlPercent * positionWeight → "+8.0% to portfolio"
  - Days held (trading days count)

**Indicators:**
- Icon: ti-activity
- Header: bearish/bullish summary count (e.g. "5/6 bearish" colored red)
- Body: rows for RSI (14), VWAP divergence, MACD, Volume trend, Bollinger, Earnings date
- Each row: indicator name | current value | colored status badge

---

### Screen 3: Alerts Feed

Chronological list of all generated signals and notifications. 

#### Top Controls
- Confidence threshold slider: "Show signals above ___%" (range: 0-100, default 50)
- Filter pills: All, Sell, Buy, Events

#### Feed Items
Each item:
- Timestamp (relative: "2h ago", "Yesterday 3:42 PM")
- Ticker + signal pill badge
- Short description
- Tap to open signal detail

Empty state for MVP: "No signals yet. Signals will appear here once the analysis engine is active."

---

### Screen 4: Settings

> **Settings are global, not per-ticker.** Every ticker detail screen looks the same — same layout, same market-stats panel, same chart controls. Whether you hold the position or not, the screen renders identically except that held positions display their position-stats section (shares, avg cost, P&L, etc.) and non-held positions don't. The inline edit panel inside TickerDetail's MarketStats component is a *convenience* surface for adjusting display preferences — but the resulting settings are stored once in `user_preferences.stat_config` and apply to **all** ticker screens.

**Settings persistence:** All user-settable preferences live in the `user_preferences` Supabase table (one row per user, keyed by Supabase user ID). The FE writes through the BE (`PUT /api/user/preferences` or equivalent — to be added in Batch 15) which validates and upserts the row. On app load, the FE reads the row once and subscribes to Realtime so multi-device users see changes propagate.

**App-level Settings (MVP scope):**

- **IB Connection**: Status indicator (connected/disconnected/session expired), last sync time, reconnect button
- **Signal Preferences**: Confidence threshold slider (same as alerts), signal_min_market_value, suppressed symbols list
- **Notifications**: DROPPED from MVP (no push notifications). Quiet-hours UI deferred until push returns post-MVP.
- **Display**: Dark/light mode toggle (or system default), market period display preferences, market-stats config (which 6-8 stats appear on the TickerDetail MarketStats panel)
- **LLM Provider**: Dropdown (Gemini / Claude / OpenAI) — selects which provider the user-triggered signal analysis uses
- **Account**: Email, sign out

---

## Design System

### Aesthetic Direction
Refined minimalism with a financial-grade feel. Think Bloomberg terminal meets modern mobile design. Dense but not cluttered. Every pixel earns its place.

### Typography
- Use a distinctive sans-serif font — NOT Inter, Roboto, or Arial
- Consider: DM Sans, Manrope, Plus Jakarta Sans, or Outfit
- Monospace for prices and numbers: JetBrains Mono, IBM Plex Mono, or Fira Code
- Font sizes: 18px for header values, 14px for ticker/price, 13px for P&L, 11-12px for secondary text, 10px for tertiary/labels
- Two weights only: 400 (regular), 500 (medium). Never 600 or 700.

### Colors
- Gain: #639922 (green-600 from our palette)
- Loss: #E24B4A (red-400)
- Near-zero: #888780 (gray-400)
- VWAP above: same green
- VWAP below: same red
- Signal pills:
  - Sell: bg #FCEBEB / text #791F1F (dark: bg #501313 / text #F09595)
  - Buy: bg #EAF3DE / text #27500A (dark: bg #173404 / text #97C459)
  - Event: bg #E6F1FB / text #0C447C (dark: bg #042C53 / text #85B7EB)
  - Watch: bg #FAEEDA / text #633806 (dark: bg #412402 / text #FAC775)
- Backgrounds: use CSS variables for light/dark mode support
- Card borders: 0.5px solid, subtle

### Dark Mode
Must be fully supported. All colors must work in both modes. Use CSS variables throughout.

### Spacing
- Card padding: 10-12px vertical, 12-14px horizontal
- Card gap: 6px between cards
- Card border-radius: 8px (md)
- Section spacing: 14px between major sections

### Animations
- Card tap: subtle scale(0.98) on press
- Sparklines: draw-in animation on load (CSS stroke-dasharray/dashoffset)
- Price updates: brief flash/highlight when price changes
- Sort transitions: smooth reorder animation when switching sort views

---

## Data Flow

### IB API → Backend (Container 2 → Container 1)
1. Node.js app communicates with IB Client Portal Gateway via localhost:5000
2. Key endpoints used:
   - `GET /portfolio/{accountId}/positions` — current positions
   - `GET /portfolio/{accountId}/summary` — account summary (total value, P&L)
   - `GET /iserver/marketdata/snapshot` — live quotes (price, VWAP, volume)
   - `GET /iserver/marketdata/history` — historical bars for sparklines/charts/technicals
   - `GET /portfolio/{accountId}/ledger` — P&L breakdown
   - `POST /tickle` — session keepalive (every 30s)
   - `POST /iserver/auth/ssodh/init` — re-initialize session after expiry

### Backend → Frontend (Oracle VPS → Vercel)
- REST API for initial data load
- Supabase Realtime for live updates: backend writes to Supabase → Supabase pushes change notification to client → client pulls updated data from Supabase (source of truth)
- Push notifications (PWA) as a separate alert channel when app is not open

### Backend → Supabase
- Position data (latest state + historical snapshots)
- User preferences (sort order, confidence threshold, stat customization, signal suppression per position)
- Generated signals and their outcomes (for future accuracy tracking)
- Auth (user session, JWT tokens)

### Backend → Redis (Container 2 → Container 3)
- Cache IB market data responses (TTL: 5-15s) to prevent redundant calls within polling interval
- Cache Finnhub responses (TTL: 5-15 min) to avoid hitting 60 calls/min limit
- Cache computed technicals per position (TTL: matches signal loop interval)
- Session data if needed

### Signal Engine Flow (runs every 15-30 min during market hours)
1. **Filter**: Check each position against signal filters (market value ≥ $200, not suppressed, not too new)
2. **Collect**: Fetch OHLCV bars from IB for each eligible position (from Redis cache if fresh, else from IB)
3. **Compute**: Calculate RSI, MACD, Bollinger, VWAP divergence, support/resistance, volume profile using `technicalindicators` library
4. **Enrich**: Fetch news + sentiment + insider trades + earnings from Finnhub for each position
5. **Synthesize**: Send structured indicator state + news context to LLM (Gemini free tier) via provider-agnostic abstraction layer
6. **Output**: LLM returns signal type (sell/buy/watch/event), confidence score (0-100), reasoning text, timeframe, target price range
7. **Store**: Write signal to Supabase signals table
8. **Notify**: Supabase Realtime notifies client of signals table change → client pulls new signal data → signal pill appears on position card. If confidence > user threshold and app is not open, send PWA push notification.
6. Notify: If confidence > user threshold, trigger push notification

---

## PWA Requirements
- Service worker for offline caching (show last-known portfolio state)
- Web app manifest for home screen installation
- Push notification support (Web Push API)
- Responsive: optimized for 375-430px width (iPhone/Android), usable on desktop
- Target: <2s initial load, <500ms for subsequent navigations

---

## Project Structure (Recommended)

```
upside/
├── client/                 # React frontend (Vite) — deploys to Vercel
│   ├── src/
│   │   ├── components/
│   │   │   ├── PortfolioHome/
│   │   │   │   ├── PositionCard.tsx
│   │   │   │   ├── SummaryStrip.tsx
│   │   │   │   ├── SortBar.tsx
│   │   │   │   ├── MarketPeriodBadge.tsx
│   │   │   │   └── Sparkline.tsx
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
│   │   │   ├── AlertsFeed/
│   │   │   ├── Settings/
│   │   │   │   └── IBLoginFlow.tsx
│   │   │   └── common/
│   │   │       └── CollapsibleSection.tsx
│   │   ├── hooks/
│   │   │   ├── usePositions.ts
│   │   │   ├── useRealtimePrices.ts
│   │   │   └── useSignals.ts
│   │   ├── services/
│   │   │   ├── supabase.ts
│   │   │   └── api.ts           # REST calls to backend
│   │   ├── types/
│   │   │   └── index.ts
│   │   ├── utils/
│   │   │   ├── formatters.ts    # currency, percent, P&L formatting
│   │   │   └── calculations.ts  # tint opacity, VWAP comparison, %/day
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   │   └── manifest.json
│   └── index.html
├── server/                 # Node.js backend — runs in Docker on Oracle VPS
│   ├── src/
│   │   ├── routes/
│   │   │   ├── portfolio.ts
│   │   │   ├── marketdata.ts
│   │   │   ├── signals.ts
│   │   │   └── auth.ts          # IB login proxy
│   │   ├── services/
│   │   │   ├── ibGateway.ts     # IB Client Portal API wrapper
│   │   │   ├── ibMappers.ts     # Boundary transformers: raw IB shapes → our types
│   │   │   ├── finnhub.ts       # News, sentiment, earnings
│   │   │   ├── signalEngine.ts  # Technical analysis + LLM synthesis (Batch 14)
│   │   │   ├── technicals.ts    # RSI, MACD, Bollinger, VWAP computation
│   │   │   ├── llm.ts           # Provider-agnostic LLM abstraction layer
│   │   │   ├── redis.ts         # Redis cache wrapper
│   │   │   └── supabase.ts      # Supabase client for server-side writes
│   │   ├── scripts/
│   │   │   └── captureIb.ts     # One-shot capture script (Batch 7 deliverable)
│   │   ├── cron/
│   │   │   ├── pricePoller.ts   # Real-time loop (5-15s)
│   │   │   ├── signalRunner.ts  # Signal loop (15-30 min)
│   │   │   └── keepalive.ts     # Supabase + IB session keepalive
│   │   ├── middleware/
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
├── infra/
│   └── clientportal.gw/      # Dockerfile that wraps IB's official clientportal.gw zip
├── supabase/
│   └── migrations/           # 001_initial.sql, 002_align_with_ib.sql
├── captures/                 # Raw IB JSON dumps (gitignored, Batch 7 output)
├── docker-compose.yml       # 3 containers: IB Gateway, Node.js, Redis (+ optional cloudflared)
├── .env.example             # LLM_PROVIDER, FINNHUB_KEY, SUPABASE_URL, etc.
├── package.json
└── README.md
```

---

## Key Metrics & Calculations

### P&L Tint Opacity
```
function getTintOpacity(pnlPercent: number): number {
  const abs = Math.abs(pnlPercent);
  if (abs < 1) return 0.04;    // near-zero: gray
  if (abs < 5) return 0.05;
  if (abs < 10) return 0.07;
  if (abs < 20) return 0.10;
  return 0.14;                  // 20%+
}
```

### P&L Color
```
function getPnlColor(pnlPercent: number): 'gain' | 'loss' | 'neutral' {
  if (pnlPercent > 1) return 'gain';
  if (pnlPercent < -1) return 'loss';
  return 'neutral';
}
```

### %/Day Return
```
tradingDaysHeld = count of trading days from entry date to today
dailyReturn = totalPnlPercent / tradingDaysHeld
// Display as: "+0.79%/day"
```

### Portfolio-Weighted Contribution
```
positionWeight = positionMarketValue / totalPortfolioValue
portfolioContribution = positionPnlPercent * positionWeight
// Display as: "Contributing +5.0% to portfolio"
```

### VWAP Comparison
```
vwapDiff = ((currentPrice - vwap) / vwap) * 100
// If > 0.1%: show green up-arrow + "+X.X% VWAP"
// If < -0.1%: show red down-arrow + "-X.X% VWAP"
// Else: show "= VWAP" in gray
```

### Portfolio Weight Bar
```
weightPercent = positionMarketValue / totalPortfolioValue * 100
// Render as horizontal bar at bottom of card
// Width = weightPercent% of card width
// Same color as P&L tint, slightly higher opacity
```
