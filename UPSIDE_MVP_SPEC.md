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
- **Market Data**: IB API (prices, OHLCV bars, fundamentals — VWAP is computed BE-side, not provided by IB), Finnhub (news, sentiment, insider trades, earnings, intraday candles — free 60 calls/min, all routed through a rate-limited queue)
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
  1. **IBeam** (`voyz/ibeam:0.5.11`) — wraps the IB Client Portal Gateway and automates its browser-based login. Exposes the gateway REST API on the compose-network hostname `ib-gateway:5000` (HTTPS, self-signed cert) — same name + protocol as the bare gateway, so the api code is unchanged. Reads IBKR credentials from `/run/secrets/ib_account` and `/run/secrets/ib_password` (files mounted in from the VPS host, see "IB Authentication Flow"). The custom `infra/clientportal.gw/Dockerfile` is kept as a fallback for if IBeam ever stops being maintained, but not used in the live stack.
  2. **Upside Node.js app** (Express + WebSocket + cron jobs + signal engine + tunnel watcher) — the brain
  3. **Redis** — local caching for IB rate-limit buffering and data deduplication
  4. **cloudflared** — Cloudflare Quick Tunnel exposing the api container over HTTPS. Runs with `--no-autoupdate` so the tunnel URL stays stable across cloudflared image updates (we trigger updates explicitly). Writes its startup log to a shared volume; the api's tunnel watcher reads it and upserts the URL into `app_config.api_url`.
- All 4 containers communicate via Docker internal bridge network (`upside`)
- **Single-user MVP scope**: one user, one IB account. Multi-user (e.g., separate accounts for family members) requires a per-user `ib-gateway` container — the IB Client Portal Gateway is single-session, so two users cannot share one gateway. The tunnel and watcher do **not** multiply with users: the api is the single public entry point and proxies to the appropriate internal `ib-gateway-N` based on user. Deferred post-MVP.

### Public URL Discovery (self-healing Quick Tunnel)

The api container is exposed to the public internet via Cloudflare Quick Tunnel (free, no custom domain required). Quick Tunnel URLs are random `*.trycloudflare.com` hostnames assigned at cloudflared process startup. They change whenever the cloudflared process restarts. Rather than pin that URL into Vercel env vars (which would force manual intervention after each restart), the system self-heals via Supabase as a runtime config store.

**Why this pattern instead of a paid domain + named tunnel:** the $10/yr domain is the simpler answer to "stable public URL," but with self-healing in place we get zero ongoing maintenance at zero cost. Estimated restart frequency in practice is 1-3 per year (Oracle VPS reboots + rare cloudflared crashes), each fully automatic from the user's perspective. The mechanism stays in place harmlessly if we later attach a domain — the URL just stops changing, watcher becomes a no-op.

**Components:**

- **`cloudflared` compose service** — runs `cloudflared tunnel --no-autoupdate --url http://api:3001 --logfile /shared/cloudflared.log`. `--no-autoupdate` is critical: without it, cloudflared self-updates ~daily and each update reassigns the Quick Tunnel URL. We update the image explicitly when we choose to.
- **`app_config` Supabase table** — key/value runtime config: `{ key: text primary key, value: text not null, updated_at: timestamptz default now() }`. RLS: public `select`, service-role `insert`/`update`/`delete`. Realtime enabled. Holds `api_url`. Designed as a generic runtime-config home for future flags.
- **Tunnel watcher (in api)** — background task in `server/src/services/tunnelWatcher.ts`. Watches the cloudflared logfile (`fs.watch` + 30s poll fallback), parses the current Quick Tunnel URL, upserts into `app_config.api_url`. In-process inside the api rather than a sidecar, because the supabase service-role client is already there — duplicating it to a sidecar broadens the secret surface for no real lifecycle benefit.
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
- **On-demand login via IBeam** — IB Client Portal Gateway only accepts authentication through its own web UI. We use [IBeam](https://github.com/Voyz/ibeam) (`voyz/ibeam:0.5.11`) — it wraps the gateway and drives the browser-based login at `localhost:5000` via a headless browser. The api treats the IBeam container exactly like the bare gateway: same `ib-gateway:5000` hostname, same Client Portal REST endpoints.
- **Critical constraint: IBKR allows only one active session per account.** If the user opens IBKR Mobile while IBeam holds a session, IBeam gets kicked out — and IBeam's default maintenance loop would re-login immediately, kicking IBKR Mobile out, ad infinitum. To respect the user's primary use of IBKR Mobile, **IBeam is off by default**:
  - `ib-gateway` is tagged with `profiles: [manual]` in `docker-compose.yml` so `docker compose up -d` does **not** start it.
  - `IBEAM_RESTART_FAILED_SESSIONS=False` and `IBEAM_AUTHENTICATION_STRATEGY=A` (less aggressive) so even when running, IBeam doesn't fight to re-claim the session.
  - User explicitly turns IBeam on/off from the Upside FE — see "Connect / Disconnect controls" below.
- **Connect / Disconnect controls in the FE**: small status indicator in the header shows IB state (`stopped` / `connecting` / `connected` / `disconnected`). Tap to connect when stopped, tap to disconnect when connected.
  - **Connect**: FE POSTs `/api/auth/ib/connect` → the api uses its Docker-socket access to issue a Docker `start` on the `ib-gateway` container → IBeam boots, logs in (~15-25s), triggers a 2FA push to the user's IB Key app → user approves → gateway authenticated (~5s later). FE shows "Approve 2FA push on IB Key app" during this window and polls `/api/auth/status` every ~3s to detect the state change.
  - **Disconnect**: FE POSTs `/api/auth/ib/disconnect` → api issues Docker `stop` on `ib-gateway` → container exits cleanly in ~2-5s → IBKR Mobile is free to use.
- **Cached-first portfolio display**: the FE shows portfolio positions from Supabase regardless of whether IB is currently connected. When connected, `pricePoller` writes fresh data and Supabase Realtime pushes updates. When IB is disconnected, the Finnhub fallback poller (see "Multi-source price polling") keeps `current_price` reasonably fresh. The status indicator's color tells the user how fresh data is. **No more full-screen "session expired" takeover**; that interrupted user flow more than it helped.
- **Docker socket access**: the api container has `/var/run/docker.sock` mounted read-write. This gives the api full Docker control on the host — accepted security trade-off for a single-user self-hosted MVP. If the api is ever exposed multi-tenant, this needs to change (e.g., a tiny privileged "control" sidecar that only allows start/stop on a whitelist of container names).
- **Tried and abandoned** (kept here as institutional memory so the next agent doesn't redo): (1) programmatic POST to `/v1/api/iserver/auth/ssodh/init` → 401; (2) api-side path proxy `/ib-portal/*` → gateway's absolute paths bypassed the prefix; (3) second dedicated Quick Tunnel to the gateway → "login succeeded" in the browser but internal queries still got 401; (4) full-time IBeam (auto-relogin) → "battle royale" with IBKR Mobile, user could not use phone app while Upside was deployed; (5) IBKR's own OAuth 1.0a Extended — works, would be the cleanest long-term answer (no session conflict with IBKR Mobile), but requires IBKR-side activation that retail accounts must request explicitly via email and may wait days-to-weeks for. OAuth implementation is parked on the `oauth-dev` branch for when approval lands.
- **Credentials** live in two files on the VPS at `~/upside/secrets/ib_account.txt` and `~/upside/secrets/ib_password.txt`, mode `0400`, owner `ubuntu`. The IBeam container mounts them read-only at `/run/secrets/ib_account` and `/run/secrets/ib_password`; IBeam reads them via `IBEAM_SECRETS_SOURCE=fs`. Files are gitignored. Credentials never appear in env vars, in `docker-compose.yml`, or in any committed code.
- **No Redis token storage in the BE for IB session** — when running, IBeam/Gateway hold the session internally; the api just polls `/v1/api/iserver/auth/status` and surfaces the result via `/api/auth/status` to the FE.
- Multi-device support: IB session shared across all user's devices (both pull from same Redis-stored session)
- Session keepalive via tickle endpoint every 30s
- IB's nightly forced logout (~11:45 PM ET) ends session daily
- On session expiry: status indicator turns red. UI does NOT full-screen takeover — portfolio remains visible from Supabase cache and Finnhub fallback poller keeps prices reasonably fresh. User taps status indicator to re-connect.
- Backend stops polling IB when session expires — no unnecessary IB API calls. Finnhub fallback poller picks up the slack.
- If IB session is killed externally (user logged into TWS directly), next backend poll detects auth error → marks expired → status indicator turns red.

### Connection Status Header
- Always-visible status dot in header next to market period badge
- Green dot → connected (no text)
- Amber dot + "Reconnecting..." → mid-session retry in progress
- Red dot + "Session expired" → user action required

### Signal Model (MVP — SELL signals on held positions only)

**Naming consistency:** the LLM's confidence in its analysis is called `signalQuality` in the schema/code (0-100) and displayed as "Quality" in the UI. Avoid the word "confidence" outside LLM prompts to prevent ambiguity with the separate Price Proximity metric.

**Trigger:** Manual only. Two-step intentional friction:
1. User taps "Analyze" on ticker detail
2. Button greys out for 1 second
3. Button shows "Confirm analyze" — user taps again to confirm
4. Analysis runs (~5-15 seconds)

**Re-analyze soft-block:** if the user re-triggers Analyze on the same symbol within 5 minutes of the last completed analysis, the BE returns HTTP 429 with `{ lastAnalyzedAt }`. The FE renders "Last analyzed 3 min ago — re-analyze anyway?" with a confirm button. Confirm re-POSTs with `force: true`. Spends no LLM tokens by accident; doesn't get in the way of testing.

**Concurrency lock (Supabase + Realtime):**
- `analysis_locks` table with row per active analysis: `{ symbol, user_id, started_at, status }`
- Supabase Realtime broadcasts lock to all connected clients → Analyze button disabled everywhere
- On completion (success or error), lock row deleted → button re-enables, new signal appears via Realtime
- Stale locks (>5 min old) auto-cleaned by cron. TTL chosen to comfortably exceed worst-case LLM response time.

**Pre-LLM filters (skip analysis entirely):**
- Skip positions with market value < $1,000 (configurable threshold)
- Skip positions where user has manually disabled signal generation
- DROPPED for MVP: "skip positions opened recently" filter (manual trigger means user controls timing)

**Cost ceiling:** env `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis, resets at midnight UTC. When exceeded, `/api/signals/analyze` returns 429 with `{ reason: 'daily_limit_reached' }` and the FE renders "Daily analysis limit reached — resets at midnight UTC". Cheap insurance against runaway spend, especially once a paid provider is in use.

**LLM response validation:** every LLM response is parsed against a Zod schema. Malformed responses trigger one retry with a stricter "respond only in this JSON shape" prompt. Second failure writes a `no_signal` row with reason "LLM response malformed" and releases the lock — analysis fails soft, never crashes the api.

**Signal structure (range-based, not point-based):**
- Engine outputs SELL with a **price range** (e.g. $193-198) and **optimal price** (the HIGH of range, since selling high = better)
- Signal is dormant until live price enters range
- Client renders SELL badge when current price ≥ range low
- **Two metrics shown separately:**
  - Signal Quality (0-100, LLM's confidence in the analysis — **immutable** post-creation)
  - Price Proximity ("at optimal" / "approaching optimal" / "edge of range" — computed from live price)
- Compact card shows: "Sell · 82% · $193–198 (target $198)"

**Mutability rules for `signals` rows:**
- **Immutable** (set on insert, never changed): `signalType`, `signalQuality`, `priceRangeLow`, `priceRangeHigh`, `optimalPrice`, `reasoning`, `indicatorBullets`, `indicatorSnapshot`, `analyzedAt`, `expiresAt`.
- **Mutating** (updated by background jobs over time): `actualMaxSinceAnalysis`, `actualMinSinceAnalysis`, `enteredRangeAt`, `exitedRangeAt`, `actedOnAt`, `supersededByAnalysisId`.

The LLM's call doesn't change after the fact; only the realized-outcome data accumulates.

**Signal expiry:** `expiresAt = analyzedAt + LLM-provided timeframe` (e.g. analyzed Mon, timeframe "3-7 days" → expires Mon+7d). On expiry the signal is hidden from active position-card UI but kept forever in history. Accuracy fields keep updating for ~30 days post-expiry so "price hit target 2 days *after* the predicted window" is still recorded — useful learning data for future signal post-mortem.

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

**Accuracy tracking (daily hindsight cron, not live):**
- Once daily at ~4:30 PM ET, `accuracyUpdater` cron walks all non-superseded signals from the last 30 days.
- For each: fetch today's intraday candles (5-min or hourly bars) from Finnhub via the rate-limited queue.
- Update `actualMaxSinceAnalysis = max(prior, today_high)`, `actualMinSinceAnalysis = min(prior, today_low)`.
- Stamp `enteredRangeAt` the first time intraday price entered `[priceRangeLow, priceRangeHigh]`; stamp `exitedRangeAt` on first subsequent exit.
- This runs IB-independent (Finnhub-only), so accuracy tracking works even when the user has IB disconnected most of the time.
- Daily granularity is sufficient — we don't need tick-level accuracy data to evaluate signal quality empirically over weeks/months.

**Info badges (non-signal context, shown on cards):**
- Earnings date proximity (e.g. "Earnings · 12d")
- Upcoming dividend dates
- Insider transactions (size/direction)
- Unusual volume (today vs 30d avg)
- Material news (sentiment-flagged via Finnhub)
- Analyst rating changes
- Extreme social sentiment (very positive or very negative)
- All shown horizontally on the compact card with right-edge ellipsis (a small "+N" pill) if there are more badges than fit. Trading signal pills render FIRST, info badges after. Card height stays fixed; overflow is signaled via the ellipsis pill, not by growing the card.

### Profit-Taking Zone Detection (continuous)

A position enters "profit-taking zone" when its unrealized P&L percent crosses a user-configurable threshold (default +2.0%, configurable in Settings under `user_preferences.profit_zone_threshold_pct`). This unifies what would otherwise be separate concepts (pre-market gap alerts, run-up alerts, news rallies, drawdown recoveries) into one mechanism: any cause that pushes P&L across the threshold triggers the same flow. Dedicated pre-market gap detection is **dropped** in favor of this unified model; gap-driven entries get a small visual marker but no separate notification.

**State tracking (fields on `positions`):**
- `zone_entered_at timestamptz null` — when current zone-membership began. NULL when not in zone.
- `zone_exited_at timestamptz null` — when last zone-membership ended (kept for post-mortem).
- `last_zone_notification_at timestamptz null` — cooldown anchor.
- `entered_zone_via_gap boolean default false` — true if zone-entry happened between yesterday's close and today's open. Cleared at end of regular session.

Zone state is recomputed on every `positions` row write by both `ibPricePoller` and `finnhubPricePoller` (see "Multi-source price polling"). A position is `inZone` when `pnl_percent >= profit_zone_threshold_pct`.

**Notifications:**
- On zone-entry (transition `!inZone → inZone`), fire one Discord notification to `#upside-zones` (separate channel from signal-range notifications so the user can independently tune Discord notification settings).
- Re-entry suppressed by a 4-hour cooldown keyed on `last_zone_notification_at`. Position can enter, exit, and re-enter within the cooldown window without triggering a new notification. Avoids chop spamming the user near the threshold.
- Zone-exit does NOT fire a notification in MVP (would create noise). Exit data is recorded for post-MVP analysis ("opportunity to take profit at +2.3% passed, position now at +0.8%" — useful for the signal post-mortem feature).

**UI emphasis on PositionCard:**
- When `inZone === true`, render a small icon (specific glyph TBD at implementation; candidates: ⇡, lightning bolt, upward arrow) next to the P&L number on the card.
- On hover (desktop) or long-press (mobile), show tooltip: `"Profit-taking zone — P&L crossed +{threshold}% threshold. Consider analyzing."`.
- When `entered_zone_via_gap`, additionally render a small "GAP" badge near the zone icon for the current trading day. Reasoning: gap-driven moves frequently fade at open due to overnight profit-taking by others — the badge tells the user "this is in zone because of a gap, watch for fade."
- Gap badge persists from market open until end of regular session, then clears. Zone state itself persists as long as P&L stays above threshold.
- Card structural layout is NOT altered — the icon and badge are the only affordances. Tapping either expands a small inline "Analyze for profit-taking?" shortcut that pre-fills the contextualTrigger so the LLM addresses the situation directly.

**LLM context — `contextualTriggers`:**
- `signalEngine` includes a `contextualTriggers` field on every LLM analysis request, structured as:
  ```
  {
    inProfitTakingZone: { thresholdPct: number, currentPnlPct: number, viaGap: boolean } | null,
    // post-MVP: imminentEarnings, recentInsiderTransaction, unusualVolume, etc.
  }
  ```
- The LLM prompt reserves a "Contextual triggers" section. When triggers are non-null, the prompt instructs the LLM to address them specifically. For zone: "should we take profit here, or hold for more?" — and if `viaGap`, additionally: "zone entry was caused by an overnight gap, which often fades at open due to others taking profit."
- The framework is forward-compatible: new trigger types can be added without prompt re-engineering. **Reserved in the prompt structure from Batch 14a onward** even though only `inProfitTakingZone` is populated initially.

### Realtime Update Architecture (no push notifications in MVP)
- All clients subscribe to Supabase Realtime on `positions`, `signals`, `analysis_locks` tables
- Backend writes to Supabase → Realtime pushes change notification to clients → clients pull latest data from Supabase (source of truth)
- Push notifications DROPPED from initial MVP and **re-added in Batch 16** as PWA push (web-push library, VAPID keys). Discord remains the developer/admin channel; PWA push is user-facing. Both fire on the same triggers (zone-entry, signal-range-entry).
- Offline users see updates when they next open the app (Realtime catches them up).

### Supabase Schema (tables)
- `positions` — current holdings per user, written by `pricePoller`, read via Realtime by the FE. Includes zone-tracking fields (`zone_entered_at`, `zone_exited_at`, `last_zone_notification_at`, `entered_zone_via_gap`) and source-tracking (`price_source` enum `'ib' | 'finnhub'`, `last_price_update_at`) for multi-source polling.
- `signals` — range-based signal records per analysis (range, indicators, reasoning, accuracy tracking). Includes `acted_on_at` for user judgment data.
- `user_preferences` — sort order, theme, LLM provider, signal threshold (generation-time minimum), suppressed symbols, `profit_zone_threshold_pct` (default 2.0)
- `analysis_locks` — concurrency control for signal analysis (5-min TTL)
- `access_attempts` — Google OAuth attempts (granted + non-whitelisted)
- `contracts` — per-conid metadata cache (company_name, industry, category, currency, exchange). Populated lazily; weekly refresh
- `external_api_metrics` — per-API-call instrumentation (provider: `'ib' | 'finnhub'`, endpoint/category, duration_ms, retries, status). 30-day TTL. Replaces the original `ib_api_metrics` table by adding a `provider` column. Foundation for empirical perf tuning of both IB and Finnhub call patterns.
- `app_config` — key/value runtime config (`{ key, value, updated_at }`). Currently holds `api_url` (current Cloudflare Quick Tunnel URL, written by the tunnel watcher; read by the FE on bootstrap and via Realtime subscription). Public read via RLS, service-role write only. See "Public URL Discovery" in Architecture for the self-healing mechanism. Designed as a generic home for future runtime flags too.
- `position_history` — **DROPPED entirely.** Originally planned for daily snapshots. Not needed because MTD comes from a Redis-cached month-start portfolio value (set on first poll of each new month) and accuracy tracking lives on the `signals` row itself. If post-MVP historical P&L charts ever need this, IB transactions API can rebuild the data on demand — no live retention required.

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
- **Computed locally from IB data**: RSI, MACD, Bollinger Bands, SMA/EMA, Stochastic, support/resistance, volume profile, **VWAP** (IB's snapshot endpoint does NOT expose VWAP as a field; we compute it from intraday history bars in `server/src/services/technicals.ts`), VWAP divergence, **`tradingDaysHeld`** (intended source: IB's transactions endpoint — find entry date for each held position, count trading days since. **⚠ Verification pending at Batch 13.5 implementation**: confirm the transactions endpoint exists, returns the data we need, and is reliable for all positions. Fallback if not: track entry-date in Upside from when we first see a position, accept that pre-Upside positions show 0 until next user-confirmed entry).
- **From IB account summary**: month-to-date (MTD) return — intended source is `/v1/api/portfolio/<acctId>/summary` or equivalent (**⚠ Verification pending at Batch 13.5 implementation**: confirm endpoint name and response shape for MTD field). Fallback if missing: compute from a lightweight position-value-at-month-start snapshot kept in Redis.
- **Finnhub provides**: company news + sentiment scores, insider transactions, earnings calendar + estimates, basic financials (supplementary), intraday candles (fallback price source when IB is disconnected, and primary source for daily hindsight accuracy tracking). All Finnhub calls route through the rate-limited request queue (see below).
- **Alpha Vantage**: DROPPED — 25 calls/day too limiting, all technicals computed locally instead
- **Sparklines**: fetched live from IB (7 daily bars per ticker), current day updates in real-time. No overnight batch needed.

### IB API Rate Limits
- Global: 10 requests/second via Client Portal API
- Historical data: no hard limit for bars ≥1 min, but soft pacing — avoid >60 requests/10 min
- With <10 positions, rate limits are not a concern. Redis cache prevents redundant calls.

### Finnhub Rate-Limited Queue

All Finnhub calls in the codebase route through `server/src/services/finnhubQueue.ts` — a fair scheduler that prevents rate-limit errors even under burst load.

**Design:**
- Token-bucket limiter at 50 calls/min globally (10-call buffer below Finnhub's 60/min free-tier ceiling). Configurable via env `FINNHUB_RATE_LIMIT_PER_MIN`.
- Each request declares a `category` (`quote`, `candle`, `news`, `insider`, `earnings`, `profile`, etc.) and a `key` (typically ticker symbol).
- **Per-category min-interval-per-key**: requests for the same `(category, key)` within the configured min-interval **wait for the next eligible slot** rather than firing immediately or returning cached data. No stale-cache returns — a waiting caller always gets fresh data when their request eventually fires. Worst-case wait equals the category's min-interval (e.g. 60s for `quote` in fallback mode).
- FIFO ordering within a category; categories share the global token bucket.
- Exponential backoff + 1 retry on any 429 response (defensive — shouldn't happen given the buffer).
- Exposed API: `finnhubQueue.request<T>(category, key, fn: () => Promise<T>): Promise<T>`.

**Initial config (Batch 13.7):** all categories default to 0s min-interval (queue acts purely as a rate limiter, not a throttle).

**Tuned config (Batch 13.9, post-feature-implementation):** per-category min-intervals set based on actual usage. Approximate initial values to be refined empirically:
- `quote`: 60s per-key (fallback-only — when IB is on, this never fires)
- `candle`: 4h per-key (accuracy cron runs once daily)
- `news`: 15min per-key
- `insider`: 12h per-key
- `earnings`: 24h per-key
- `profile`: 7d per-key

### Multi-source price polling (IB primary, Finnhub fallback)

The "real-time loop" in the Three Loops section is implemented as two cooperating pollers that write to the same `positions` row:

- **Primary (`ibPricePoller`)**: runs only when IB session is `connected`. Adaptive cadence (10s / 60s / 5min depending on market period). Writes to Supabase with `price_source: 'ib'` and stamps `last_price_update_at`. Best granularity, best data, but requires user to have IB connected.
- **Fallback (`finnhubPricePoller`)**: runs continuously, 60s cadence, always-on. For each held position, if `last_price_update_at` is null or older than 90s, fetches a quote via `finnhubQueue.request('quote', symbol, ...)` and writes with `price_source: 'finnhub'`. Routes through the rate-limited queue, so no risk of 429s even with many positions.

Both pollers recompute zone state on every write (see "Profit-Taking Zone Detection"). The FE renders `current_price` agnostic to source. A small "Live IB" / "Finnhub backup" indicator on cards can be added in a polish pass if useful — deferred from MVP since the freshness signal is already in the IB status dot in the header.

**Why this is better than the original always-IB design:** matches the on-demand IBeam model from Batch 13. Prices update in Supabase even when the user has IB disconnected to use IBKR Mobile. Zone notifications and signal-range notifications keep firing. The user gets a working app whether or not IB is currently up; IB just makes things sharper.

### Supabase Keepalive
- Backend pings Supabase with a lightweight query every few hours to prevent 7-day inactivity pause
- Not an issue with daily trading, but insurance for vacations/breaks

### Architecture Pattern
- NOT microservices — monolith Node.js app with external integrations
- Single Node.js process handles: API endpoints, WebSocket connections, IB gateway communication, signal engine cron, Finnhub/LLM calls
- IB Gateway is a separate container only because it's IB's Java software with its own lifecycle
- Can decompose later if needed (e.g., Python ML service), but unnecessary for MVP

### Three Loops in the Node.js App
1. **Multi-source price polling** (continuous, IB primary + Finnhub fallback):
   - `ibPricePoller`: runs only when IB session is `connected`. Adaptive cadence (10s / 60s / 5 min by market period). Writes with `price_source: 'ib'`.
   - `finnhubPricePoller`: runs continuously, 60s cadence, only writes if `ibPricePoller` hasn't written within the last 90s. Routes through the Finnhub rate-limited queue. Writes with `price_source: 'finnhub'`.
   - Both pollers recompute zone state on each write and trigger any zone/signal-range Discord notifications inline.
2. **Daily hindsight accuracy cron** (`accuracyUpdater`, once daily at ~4:30 PM ET): for each non-superseded signal in the last 30 days, pull today's intraday candles from Finnhub, update `actualMaxSinceAnalysis` / `actualMinSinceAnalysis`, stamp `enteredRangeAt` / `exitedRangeAt` as appropriate. IB-independent.
3. **Keepalive loop** (every few hours): Supabase ping + IB session tickle (when IB is connected).

Signal generation is **user-triggered only** in MVP — there is no automated signal scanning cron. Automated scanning is post-MVP, paired with PWA push notifications so users get alerted when not in the app.

---

## MVP Build Order

> **Operational sequencing lives in `BUILD_QUEUE.md`.** The Sprint outline below is a planning ladder describing what gets built and roughly in what phase. The actual execution unit is the **batch**, tracked in `BUILD_QUEUE.md`, with per-batch claims in `CLAIMS.md`. When the two disagree, the queue wins. The "data-only live" milestone (phone shows real portfolio + auth working, no signals yet) was reached at Batch 13. Remaining MVP work is laid out as Batches 13.1, 13.5, 13.7, 13.8, 14a, 14b, 14c, 14d, 14.5, 13.9, 15, and 16.

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
9. Signal analysis engine — manual trigger only, SELL signals on held positions
10. Signal pills on position cards (range-based, fired when live price in range)
11. Signal detail view (Style A analytical breakdown)
12. Signal history per ticker
13. Analysis lock pattern (concurrent-safe via Supabase Realtime)
14. Profit-taking zone detection with Discord notifications

### Sprint 4 — Polish (~1 week)
15. Alerts feed screen (Positions only in MVP)
16. Settings screen (MVP scope: IB connection, signal preferences, theme, LLM provider, profit-zone threshold)
17. PWA push notifications (same triggers as Discord)
18. Multi-device sync via shared IB session in Redis

### Out of MVP — DROPPED
- ❌ Watchlists (regular and active) — first thing post-MVP
- ❌ BUY signals (only SELL signals in MVP since BUY relates to entries/watchlist)
- ❌ Automated signal scanning / cron-based analysis
- ❌ Alpha Vantage (all technicals computed locally)
- ❌ Upstash Redis external (self-hosted in Docker)
- ❌ IBeam / automated IB login (manual via browser autofill) — superseded by **on-demand IBeam** in Batch 13
- ❌ Pre-market gap detection as a separate cron — replaced by continuous profit-taking zone detection (a gap that crosses the threshold fires the same notification as any other cause). Pre-market gap context is preserved as a UI badge on cards for the day.
- ❌ Live tick-by-tick accuracy tracking — replaced by daily hindsight cron from Finnhub intraday candles. Cheap, IB-independent, sufficient granularity.
- ❌ `position_history` table — never had a real consumer; MTD comes from Redis cache, accuracy lives on `signals`.

---

## Post-MVP Roadmap

This section captures the design intent for features that will be built **after** MVP completion (Batch 16). MVP scope is sealed; items here cannot enter MVP unless they become hard dependencies of an MVP item. This section is the design-lock for these features so when their batches eventually get written, the agent doesn't have to re-litigate architecture.

Items are listed in approximate build order, with the Watchlist track first since it's the largest cohesive block and unlocks everything that follows it.

---

### Contextual Settings Pattern

Before the post-MVP screens land, lock in a UX convention used throughout: **settings are contextual to the screen they affect, not centralized into one mega-settings-screen.**

- **App-level Settings** (Settings tab in bottom nav) — only truly app-wide concerns: IB Connection, signal generation threshold, profit-zone threshold, theme, LLM provider, sign out.
- **Per-screen Settings** — accessed via a gear icon (ti-settings) in the top-right of the screen header. Tapping opens a sheet/modal scoped to that context, not a full screen takeover.
  - **Portfolio screen**: sort defaults, custom-sort drag order management.
  - **Watchlists tab** (the list-of-watchlists view): "Unhide watchlists," reorder visible watchlists.
  - **Single watchlist screen**: "Unhide tickers in this watchlist," watchlist-specific display preferences.
  - **TickerDetail screen**: already exists as the inline "Edit" link on MarketStats; stays.
  - **Alerts screen**: display-filter defaults, "Mark all seen" controls (if added).

The pattern keeps the app-level Settings screen clean and lets each surface own its own concerns. When adding a new screen in the future, check if any of its preferences are screen-scoped — if yes, they belong in that screen's gear icon, not in app-level Settings.

---

### Track 1: Watchlists + BUY Signals

**Goal:** unlock buy-side intelligence. User can see all tickers they're tracking in IB, hide noise, get BUY signals on demand for any tracked ticker, and have an auto-populated "Active Watchlist" of tickers currently showing live BUY signals.

#### Architecture: three list-of-tickers surfaces

All flow into the same TickerDetail screen. Three contexts differ in **how the list is populated**:

1. **Portfolio** — system-written from IB positions. User has zero curation.
2. **Watchlists (regular)** — one-way mirror from IB watchlists. System-written from IB. User has zero curation **in MVP-style write semantics** — Upside cannot create, rename, or edit membership. Watchlists in Upside follow IB's lead the same way Portfolio does.
3. **Active Watchlist** — system-written, derived from signal state. Contains every ticker (from any watchlist) that currently has a live, non-superseded, non-expired BUY signal.

User curation lives in a single Upside-side mechanism: **hide**. Watchlists can be hidden from the tab strip. Tickers within a watchlist can be hidden from the list. Hiding is reversible via per-screen Settings. Hiding ≠ deleting — the IB-mirrored data is untouched, only the visibility flag is Upside-side.

When the user truly wants a watchlist (or ticker on it) gone permanently, they delete it in IB. Upside's next sync removes it. **One source of truth for membership: IB.**

This is the same trust pattern as Portfolio. The user trusts IB to be the system of record for what they own and what they're tracking; Upside layers intelligence and presentation on top, but doesn't try to be a second source of truth.

#### Two-way creation: deferred

Letting Upside create or edit IB-side watchlists is **explicitly deferred to a later post-MVP track**. Until that lands, the one-way model is the design.

#### Bottom navigation expands to 4 tabs

Order: **Portfolio · Watchlists · Alerts · Settings**

(Chat icon dropped per MVP scope; no plans to bring it back at this stage.)

#### Watchlists screen — top-level (the tab)

Lists all visible watchlists. Tab-strip-style horizontal scroll across the top:

```
[ Active · ⭐ NVDA Watch · Earnings Week · Megacap · +hide-toggle gear ]
```

- **Active** is pinned leftmost. Cannot be hidden. Cannot be renamed. Cannot be deleted.
- Regular watchlists come from IB in IB's order. User can hide; ordering follows IB.
- Gear icon at far right → contextual settings sheet:
  - "Unhide watchlists" — checklist of all currently-hidden IB watchlists, tap to unhide.
  - (Future) "Reorder visible watchlists" if Upside-side reorder makes sense without conflicting with IB sync.

Below the tab strip: the currently-selected watchlist's list of TickerCards.

#### Single watchlist screen

What you see when you tap into a specific watchlist tab. Vertical scroll of TickerCards (same component as Portfolio). Top-right gear icon → contextual settings sheet:
- "Unhide tickers" — checklist of tickers in this watchlist that the user has hidden. Tap to unhide.
- Display preferences if any emerge.

Long-press on a ticker card → action menu including "Hide from this watchlist." Hiding a ticker only affects this watchlist; the same ticker on another watchlist (or in Portfolio) is unaffected.

#### The Active Watchlist

A derived virtual list. No stored membership — it's computed from `signals`:

> Active = { all tickers where there exists a signal row with `signalType = 'buy'` AND `superseded_by_analysis_id IS NULL` AND `expires_at > now()` AND current price is within range OR within an "approaching" threshold of range }

Recomputed on every signal change (Realtime) and every price write (poller). Rendered with the same TickerCard component. BUY signal pill always present (it's the membership criterion).

User cannot manually add or remove items. Removal happens when the signal expires, gets superseded by a `no_signal`, or the user explicitly dismisses (which becomes a Settings option later — for now, the signal lifecycle handles it).

#### TickerCard generalization

Today's `PositionCard` becomes `TickerCard` with variants:

```ts
type TickerCardVariant =
  | { kind: 'held'; position: Position }        // current PositionCard rendering
  | { kind: 'watchlist'; ticker: WatchlistTicker; signal?: Signal };
```

**Held variant** (current MVP card) includes: P&L combined, P&L tint, portfolio weight bar.

**Watchlist variant** strips: P&L tint, portfolio weight bar, today's P&L lines (you don't own it, no P&L exists). Keeps: sparkline, current price, today's change, VWAP indicator, signal pill row, info badges. When there's a BUY signal, the card shows the target buy range/optimal price prominently in the same row that holds the P&L numbers on held cards.

Both variants share: ticker symbol, company name, sparkline, current price, today's change %, VWAP arrow, signal pill row with info badges, +N overflow pill, tap-to-open TickerDetail.

This is a small refactor of the existing PositionCard, not a new component from scratch.

#### BUY signal generation

BUY signals coupled into the same batch as Watchlists screen + Active Watchlist (one cohesive feature).

Engine changes:
- `signalEngine.analyze()` learns to emit `signalType: 'buy'` in addition to `'sell'` / `'no_signal'`.
- For BUY: `priceRangeLow` = optimal entry price, `priceRangeHigh` = maximum acceptable entry, `optimalPrice` = `priceRangeLow` (entering cheap = better).
- LLM prompt expands its contract to consider buy-side reasoning when analyzing a non-held ticker. Held tickers still primarily get SELL analysis (you don't typically buy more of something you already hold, though the LLM can choose `no_signal` or BUY in special cases — leave it open).
- Accuracy tracking: `actualMinSinceAnalysis` becomes the relevant field for BUY signals (lowest price seen since signal generated — did the price actually come down to optimal?). The schema already has both `actualMaxSinceAnalysis` and `actualMinSinceAnalysis` from MVP, so no migration needed.

UI for BUY:
- Same Analyze button on TickerDetail, regardless of variant. For non-held tickers (watchlist-only), Analyze is the only action available — no PositionStats section to render.
- BUY signal pill colors: green (`bg #EAF3DE / text #173404` in dark mode), distinct from SELL's red.
- Signal-range Discord channel for BUY: `DISCORD_WEBHOOK_SIGNALS_BUY` (already reserved in MVP Batch 14d notes).

#### Signal triggering — explicit cost-control philosophy

**Manual, one-ticker-at-a-time, user-initiated. Permanently.**

There is no automated scanning cron and no plans to add one. The user goes ticker by ticker and clicks Analyze on what they care about. This is the system's cost control — every LLM call is a deliberate user action.

Future *manual-but-faster* workflows that respect this constraint:
- **Multi-select Analyze**: select N tickers (checkbox on cards) → tap "Analyze selected" → queue runs them sequentially, respecting daily cost ceiling. Still user-gated.
- **Analyze all visible**: on a single watchlist screen, "Analyze all" runs every visible ticker in that list through the engine. Single user action, sequential execution, cost-capped.
- **LLM-recommended triage** ← most interesting future workflow. Two LLM round-trips:
  1. User taps "Recommend tickers to analyze" on a watchlist screen.
  2. BE collects light snapshots (price, today change, VWAP, latest news headlines, basic technicals) of all visible watchlist tickers — one batched LLM call: *"Given these snapshots, which 3-5 tickers look most worth a deep analysis right now, and why? Prefer undervalued + good news + good fundamentals + hasn't broken out yet."*
  3. LLM returns ranked short list with one-line reason each.
  4. FE renders the recommendations, user reviews and approves which ones to deep-analyze.
  5. Approved tickers go through the normal Analyze flow one by one.
  6. Two LLM round-trips per ticker that gets analyzed (recommend prompt + analyze prompt). Zero LLM cost on rejected recommendations. Still 100% user-gated.

This is "LLM as triage assistant," not "LLM as autonomous scanner." It scales the user's attention without abandoning their cost control.

#### Data model

Schema below incorporates findings from the Batch 13.2 live capture against real IBKR data (see `captures/iserver/watchlists/latest.json` and `captures/iserver/watchlist/id=*/latest.json`).

```sql
-- One row per IB user_list watchlist mirrored into Upside.
-- Membership and metadata are IB-authoritative. Upside writes only on sync.
--
-- Sync filter: only `user_lists` from /v1/api/iserver/watchlists are mirrored.
-- IBKR also returns `system_lists` (NAMED_USINDETF, CUSTOM_TIPRANKS_*, etc. —
-- ~28 of them, pre-bundled IBKR templates), which are not personal curation
-- and are explicitly skipped.
create table watchlists (
  id text primary key,                  -- IB watchlist ID (e.g. "100", "105")
  user_id uuid not null references auth.users(id),
  name text not null,                   -- IB-supplied name
  position int not null default 0,      -- derived from API response array order;
                                        -- IBKR doesn't return an explicit position
  read_only boolean not null default false,  -- from IB; user_lists are read_only=false
  modified_at timestamptz null,         -- from IB's `modified` (ms epoch). Enables
                                        -- skip-sync-if-unchanged optimization.
  last_synced_at timestamptz not null default now(),
  hidden_at timestamptz null,           -- Upside-side flag, user-set
  unique (user_id, id)
);

-- One row per (watchlist, ticker) pair.
-- Membership is IB-authoritative; Upside writes only on sync.
-- hidden_at is Upside-side, user-set.
create table watchlist_tickers (
  watchlist_id text not null references watchlists(id) on delete cascade,
  conid bigint not null,
  symbol text not null,                 -- from IB's `ticker` / `fullName`
  name text null,                       -- company name from IB's `name`
  asset_class text not null,            -- IB's `assetClass`: STK / OPT / FUT / CASH / etc.
                                        -- Signal generation gated to STK in MVP.
  position int not null default 0,      -- derived from API response array order
  added_at timestamptz not null default now(),  -- when first synced into Upside
  hidden_at timestamptz null,
  primary key (watchlist_id, conid)
);

create index if not exists watchlist_tickers_user_idx on watchlist_tickers (watchlist_id);
create index if not exists watchlist_tickers_symbol_idx on watchlist_tickers (symbol);
```

**Asset class scope.** Watchlists in IB can contain any instrument type — stocks (`STK`, which also covers ETFs), options (`OPT`), futures (`FUT`), forex (`CASH`), commodities (`CMDTY`), bonds (`BOND`), etc. Upside stores all of them in `watchlist_tickers` so the user sees their full watchlist as-is, but **Analyze is offered only on `asset_class = 'STK'` rows** — non-STK rows render the card without an Analyze affordance, with a small "Not analyzable" hint instead. Rationale: the signal engine's LLM prompts and indicator computations are built for equities; options/futures/FX need different analytical frameworks that aren't in MVP scope.

**Index ETFs are `STK`** in IBKR's API (same asset class as common stocks), so they're naturally analyzable. Cryptocurrencies (`CRYPTO`) and forex (`CASH`) are out of scope for analysis in MVP.

Active Watchlist is a derived view, not a stored table:

```sql
create view active_watchlist as
select distinct on (s.symbol)
  s.symbol, s.conid, s.* as signal
from signals s
where s.signal_type = 'buy'
  and s.superseded_by_analysis_id is null
  and s.expires_at > now()
order by s.symbol, s.analyzed_at desc;
```

(Refinement TBD: whether to filter to "live or approaching range" in the view, or in the FE. Probably FE so the view stays cheap.)

#### Sync mechanism

A new cron (`watchlistSyncer`, daily or on-demand) pulls IB watchlists via `/v1/api/iserver/watchlists`. **Filter to `user_lists` only** — skip `system_lists` (IBKR's pre-bundled templates). For each user list, fetch `/v1/api/iserver/watchlist?id=<id>` and upsert into `watchlists` and `watchlist_tickers`. Deletes (cascade) rows for user lists no longer present in IB.

Sync-skip optimization: if the cron sees a list's IB `modified` timestamp is ≤ the stored `modified_at`, skip the per-watchlist fetch for that list (membership hasn't changed). Cuts API calls on no-op syncs.

User-set `hidden_at` flags are preserved across syncs (the sync writes to `name`, `position`, `modified_at`, membership rows — not to `hidden_at`).

**Capture done in Batch 13.2.** Live API responses for `/v1/api/iserver/watchlists` and `/v1/api/iserver/watchlist?id=<user_list_id>` are in `captures/iserver/watchlists/latest.json` and `captures/iserver/watchlist/id=<id>/latest.json`. The schema above is built against those shapes.

#### Build order within this track

1. **IB watchlist import (one-way mirror)** — schema, sync cron, FE plumbing to read `watchlists` and `watchlist_tickers`. No BUY signals yet, no Active Watchlist yet, no screen yet. Internal foundation.
2. **Watchlists screen + tab strip + TickerCard variants + BUY signals + Active Watchlist** — one cohesive batch. Most of the code already exists from MVP (signal engine, TickerDetail, signal pills, Discord notifier); the surface area is the UI plus extending the engine to emit BUY.

Two batches total for the Watchlist track. Both depend on Batch 16 (MVP complete) at minimum and Batch 13.2 (passthrough endpoint, used for capturing IB watchlist shapes ahead of design).

---

### Track 2: Two-Way Watchlist Editing

Upside can create / rename / edit-membership of IB watchlists. Requires figuring out whether IB Client Portal exposes write endpoints for watchlists (TBD via passthrough capture) and the conflict-resolution model when both Upside and IB-native UI modify the same watchlist. Likely uses last-write-wins with a "modified in Upside" indicator.

Deferred until Track 1 has been in use long enough to know whether two-way is actually wanted (vs. accepted that IB is the editing surface).

---

### Track 3: Smarter Analyze Workflows

In priority order:

1. **Multi-select Analyze** — checkbox on cards, "Analyze selected" button, sequential execution, cost-capped.
2. **Analyze all visible** — single button on a watchlist or portfolio screen, runs the full visible list through the engine.
3. **LLM-recommended triage** — two-round-trip flow described above.

Each is a small additive feature on top of the existing engine. No new schema; just routing.

---

### Track 4: Signal Quality Feedback Loop

1. **Signal post-mortem with thumbs-up/down feedback** — auto-generates one-line outcome per expired/hit signal ("Sell signal on NVDA at $193-198 expired after 7 days, price peaked at $196.40 — didn't reach optimal"). User thumbs-up/down. Aggregates over time into "your accuracy on this LLM provider, this signal type, this market regime."
2. **"What changed" digest** — morning summary delivered via Discord and PWA push: overnight moves, upcoming earnings (next 7 days), new insider activity, zone-state changes since yesterday's close. High signal-density per screen.
3. **Position thesis** — user-editable text per position included in LLM analysis context. Forces articulation of why you hold what you hold; makes the LLM's reasoning specifically address your thesis ("you bought NVDA on AI capex tailwind; that thesis is intact but valuation has stretched...").
4. **Additional `contextualTriggers`** — imminent earnings (<24h), recent insider transactions, unusual volume, news-event proximity. Wires into the same `contextualTriggers` field reserved in MVP Batch 14a.

---

### Track 5: New Surfaces

1. **AI chat** — conversational portfolio Q&A. Tap chat icon (returns to bottom nav as 5th tab or replaces something), ask "why is BBAI down today?", get sourced answer pulling from positions + signals + news. Expensive (every message = LLM call) — gate behind a daily message ceiling.
2. **Natural language ticker screener** — "show me tickers with RSI > 70 and earnings in the next 5 days." Replaces traditional screener UI with LLM-as-query-translator.
3. **"Why didn't this fire?" inverse query** — cheap LLM call explaining why a position has no current signal. Different from full Analyze: cheaper, faster, no commitment. Builds trust in the no-signal state.
4. **Trade journal** — per-trade notes, %/day metric, post-trade reflection. Hooks into IB transactions endpoint for the entry/exit data, user adds the reasoning.

---

### Track 6: Time Travel

1. **Replay mode** — view historical app state ("what would the app have shown 5 days ago?"). Killer feature for evaluating whether the system would have caught a move retrospectively. Requires keeping enough historical position + signal data to reconstruct; small change since signals are already kept forever.

---

### Track 7: New Modalities

1. **Voice quick-analyze** — "Hey Upside, what about NVDA?" via Web Speech API. Free; matches the phone-first product shape.

---

### Track 8: New Asset Classes

1. **Options / shorts / trade execution** — separate concern, separate scope. Likely never enters this app's domain (Upside is intelligence, not execution); execution stays in IBKR Mobile / TWS. Listed here for completeness.

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
│ NVDA       ⇡ +$3,240 (+18.2%)  ▁▂▃▄▅  $140.40 │
│ NVIDIA Corp                          +$1.82 (+1.3%) │
│                                      ↑ +0.8% VWAP │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ (portfolio weight bar) │
├──────────────────────────────────────────────┤
│ [Sell · 82%] [Earnings · 12d]    [+2] >  │
└──────────────────────────────────────────────┘
```

**Left column (~78px min):**
- Ticker symbol (14px, weight 500, primary color)
- Company name (10px, tertiary color, truncated with ellipsis at ~76px)

**Center area (flex):**
- Optional zone icon (⇡) immediately before the P&L number when `inZone === true`. Hover/long-press tooltip: "Profit-taking zone — P&L crossed +X% threshold. Consider analyzing."
- Optional "GAP" mini-badge after the zone icon when `entered_zone_via_gap === true` (current trading day only).
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

**Signal + badge row (conditional — only shown when at least one badge or signal exists):**
- Separated by a thin border-top (0.5px)
- Horizontal flex layout, scroll/clip to single line, right-edge ellipsis pill ("+N") if overflow
- Trading signal pills render FIRST in priority order: `[Sell · 82%]`, `[Buy · 71%]` (post-MVP)
- Then info badges: `[Earnings · 12d]`, `[Insider · sell]`, `[Vol · 2.3x]`, etc.
- Signal pill colors:
  - Sell: bg #FCEBEB / text #791F1F (dark: bg #501313 / text #F09595)
  - Buy: bg #EAF3DE / text #173404 (dark: bg #173404 / text #97C459)
  - Event: bg #E6F1FB / text #042C53 (dark: bg #042C53 / text #85B7EB)
  - Watch (info badges): bg #FAEEDA / text #633806 (dark: bg #412402 / text #FAC775)
- "+N" overflow pill is muted gray
- Chevron-right arrow at far right indicating tap-to-expand
- Tapping anywhere on the signal pill opens the Signal Detail view (Style A); tapping an info badge opens the relevant section in TickerDetail

**Cards without any signal or badge** have no signal row — clean, compact card.

#### Bottom Navigation Bar
Three tabs with icons + labels (MVP scope — Watchlist and Chat dropped):
- Portfolio (ti-chart-pie) — active
- Alerts (ti-bell)
- Settings (ti-settings)

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
- Header: signal type + Quality (e.g. "Sell · 82%")
- Body contains:
  - Signal summary text (1-2 sentences)
  - If position `inZone`: inline "Analyze for profit-taking?" shortcut button that triggers a normal Analyze flow (the `contextualTriggers` get auto-attached server-side based on current zone state)
  - "Full signal breakdown" expandable section
  - Full breakdown (Style A):
    - Quality bar (0-100%, colored fill)
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

Chronological list of all generated signals, zone-entries, and (post-MVP) info badges that fired notifications.

#### Top Controls
- **Display filter slider**: "Show signals above ___% Quality" (range: 0-100, default 50). **This is a display filter only — it does NOT affect what gets generated.** Settings has a separate "Signal generation threshold" which is the BE-level minimum for bothering to generate at all.
- Filter pills: All / Sell / Zone-Entry / no_signal

#### Aggregate Accuracy Display (top of feed)
Pulled from `GET /api/signals/accuracy` (Batch 14b). Format: "Recent SELL signals: X% hit-rate over 30d, median +Y% from optimal price." Placeholder copy if data is sparse in early days.

#### Feed Items
Each item:
- Timestamp (relative: "2h ago", "Yesterday 3:42 PM")
- Ticker + signal pill badge (or zone-entry pill for zone events)
- Short description
- "I acted on this" button → POST sets `signals.acted_on_at` (or equivalent for zone events). Used in post-mortem feature later to compare LLM prediction vs. user action.
- Tap to open signal detail

Empty state for MVP: "No signals yet. Tap Analyze on any position to generate one."

---

### Screen 4: Settings

> **Settings are global, not per-ticker.** Every ticker detail screen looks the same — same layout, same market-stats panel, same chart controls. Whether you hold the position or not, the screen renders identically except that held positions display their position-stats section (shares, avg cost, P&L, etc.) and non-held positions don't. The inline edit panel inside TickerDetail's MarketStats component is a *convenience* surface for adjusting display preferences — but the resulting settings are stored once in `user_preferences.stat_config` and apply to **all** ticker screens.

**Settings persistence:** All user-settable preferences live in the `user_preferences` Supabase table (one row per user, keyed by Supabase user ID). The FE writes through the BE (`PUT /api/user/preferences` — added in Batch 15) which validates and upserts the row. On app load, the FE reads the row once and subscribes to Realtime so multi-device users see changes propagate.

**App-level Settings (MVP scope):**

- **IB Connection**: Status indicator (connected/disconnected/session expired/stopped), last sync time, Connect/Disconnect button (uses on-demand IBeam flow from Batch 13).
- **Signal Generation Threshold**: minimum `signalQuality` below which the BE doesn't generate a signal (or marks it `no_signal`). Acts at generation time. **Distinct from the Alerts feed display filter.**
- **Signal min market value** ($): persists to `user_preferences.signal_min_market_value`.
- **Suppressed symbols**: text list — symbols where Analyze is disabled.
- **Profit-Taking Zone Threshold**: slider 0.5%-10%, default 2%, persists to `user_preferences.profit_zone_threshold_pct`. Determines when a position enters profit-taking zone and triggers Discord notification + card icon.
- **Theme**: Dark / Light / System.
- **LLM Provider**: Dropdown (Gemini / Claude / OpenAI). Selects which provider the next signal analysis uses.
- **Notifications** (Batch 16): PWA push permission status, quiet-hours toggle. Discord-only is acceptable MVP if scope tightens.
- **Account**: Email, sign out.

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
1. Node.js app communicates with IB Client Portal Gateway via internal hostname `ib-gateway:5000`
2. Key endpoints used:
   - `GET /portfolio/{accountId}/positions` — current positions
   - `GET /portfolio/{accountId}/summary` — account summary (total value, P&L, MTD)
   - `GET /iserver/marketdata/snapshot` — live quotes (price, VWAP, volume)
   - `GET /iserver/marketdata/history` — historical bars for sparklines/charts/technicals
   - `GET /portfolio/{accountId}/transactions` — for `tradingDaysHeld` (verify in Batch 13.5)
   - `GET /portfolio/{accountId}/ledger` — P&L breakdown
   - `POST /tickle` — session keepalive (every 30s)
   - `POST /iserver/auth/ssodh/init` — re-initialize session after expiry

### Backend → Frontend (Oracle VPS → Vercel)
- REST API for initial data load (with public URL discovered from `app_config.api_url`)
- Supabase Realtime for live updates: backend writes to Supabase → Supabase pushes change notification to client → client pulls updated data from Supabase (source of truth)
- PWA push notifications (Batch 16) as a separate alert channel when app is not open

### Backend → Supabase
- Position data (latest state, written by both IB and Finnhub pollers)
- User preferences (sort order, thresholds, stat customization, signal suppression, profit-zone threshold)
- Generated signals and their accumulating accuracy data
- Auth (user session, JWT tokens via Supabase Auth)
- Runtime config (`app_config.api_url`)
- API call instrumentation (`external_api_metrics`)

### Backend → Redis (Container 2 → Container 3)
- Daily LLM call counter (`llm_calls:YYYY-MM-DD`, midnight-UTC TTL) for cost ceiling
- Cache IB market data responses (TTL: 5-15s) to prevent redundant calls within polling interval
- Cache computed technicals per position (TTL: matches analysis cadence)
- Portfolio-value-at-month-start cache for MTD fallback computation (set once per month, no TTL)
- Session-related data if needed

### Backend → Finnhub
- All calls route through `finnhubQueue.request(category, key, fn)`
- Categories: `quote` (fallback polling), `candle` (accuracy cron), `news`, `insider`, `earnings`, `profile`
- Per-category min-intervals set in Batch 13.9 once usage patterns are known

### Signal Engine Flow (user-triggered, manual)
1. **Pre-check**: re-analyze soft-block (last analysis within 5 min?) → 429 with confirm prompt if so. Daily cost ceiling → 429 if exceeded. Lock acquisition.
2. **Filter**: skip if market value < threshold or symbol suppressed.
3. **Collect**: Fetch OHLCV bars from IB (Redis cache if fresh).
4. **Compute**: RSI, MACD, Bollinger, VWAP via `technicalindicators` library.
5. **Enrich**: News + sentiment + insider + earnings from Finnhub (through the queue).
6. **Context triggers**: read position's zone state; populate `contextualTriggers.inProfitTakingZone` if applicable.
7. **Synthesize**: send structured indicator state + news context + contextualTriggers to LLM via the provider-agnostic abstraction.
8. **Validate**: Zod-parse LLM response. On malformed: retry once with stricter prompt. Second failure: write `no_signal` row.
9. **Store**: write signal to Supabase. Release lock.
10. **Notify**: Supabase Realtime pushes new signal to FE → signal pill appears on position card and TickerDetail's SignalSection updates.

### Profit-Taking Zone Flow (continuous, automated)
1. **Both pollers** (IB and Finnhub) recompute zone state on every `positions` row write.
2. On transition `!inZone → inZone`: check 4h cooldown on `last_zone_notification_at`. If outside cooldown, fire Discord notification to `#upside-zones`, set `last_zone_notification_at = now()`.
3. Determine `entered_zone_via_gap` (zone-entry timestamp before today's market open) → set boolean flag for the day.
4. Supabase Realtime pushes updated position to FE → zone icon (and gap badge if applicable) appears on card.

### Signal-Range Entry Flow (continuous, automated)
1. **Both pollers** check all open signals (not superseded, not expired) for the position being written.
2. If `current_price` enters `[priceRangeLow, priceRangeHigh]` and `enteredRangeAt IS NULL`: fire Discord notification to `#upside-signals-sell`, set `enteredRangeAt`.

### Accuracy Cron Flow (daily, ~4:30 PM ET)
1. For each non-superseded signal in last 30 days: fetch today's intraday candles via Finnhub queue.
2. Update `actualMaxSinceAnalysis`, `actualMinSinceAnalysis` based on today's high/low.
3. Stamp `enteredRangeAt` / `exitedRangeAt` if intraday price crossed thresholds.

---

## PWA Requirements
- Service worker for offline caching (show last-known portfolio state)
- Web app manifest for home screen installation
- Push notification support via Web Push API (Batch 16)
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
│   │   │       ├── CollapsibleSection.tsx
│   │   │       └── Tooltip.tsx           # used by zone icon hover/long-press
│   │   ├── hooks/
│   │   │   ├── usePositions.ts
│   │   │   ├── useRealtimePrices.ts
│   │   │   ├── useSignals.ts
│   │   │   ├── useAnalysisLock.ts
│   │   │   └── useUserPreferences.ts
│   │   ├── services/
│   │   │   ├── supabase.ts
│   │   │   ├── api.ts                    # REST calls to backend (URL from apiUrl.ts)
│   │   │   └── apiUrl.ts                 # public URL discovery
│   │   ├── types/
│   │   │   └── index.ts
│   │   ├── utils/
│   │   │   ├── formatters.ts             # currency, percent, P&L formatting
│   │   │   └── calculations.ts           # tint opacity, VWAP comparison, %/day
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── public/
│   │   ├── manifest.json
│   │   └── service-worker.js             # added in Batch 16
│   └── index.html
├── server/                 # Node.js backend — runs in Docker on Oracle VPS
│   ├── src/
│   │   ├── routes/
│   │   │   ├── portfolio.ts
│   │   │   ├── marketdata.ts
│   │   │   ├── signals.ts                # incl. /accuracy
│   │   │   ├── auth.ts                   # IB + Google OAuth
│   │   │   ├── user.ts                   # preferences PUT/GET
│   │   │   └── health.ts                 # deep /healthz
│   │   ├── services/
│   │   │   ├── ibGateway.ts              # IB Client Portal API wrapper
│   │   │   ├── ibMappers.ts              # Boundary transformers
│   │   │   ├── finnhub.ts                # News, sentiment, earnings, quotes, candles
│   │   │   ├── finnhubQueue.ts           # Rate-limited fair scheduler
│   │   │   ├── signalEngine.ts           # Technical analysis + LLM synthesis
│   │   │   ├── technicals.ts             # RSI, MACD, Bollinger, VWAP computation
│   │   │   ├── llm.ts                    # Provider-agnostic LLM abstraction
│   │   │   ├── discord.ts                # Multi-channel notifier (errors, zones, signals)
│   │   │   ├── webPush.ts                # PWA push (Batch 16)
│   │   │   ├── redis.ts                  # Redis cache wrapper + LLM cost counter + MTD cache
│   │   │   ├── supabase.ts               # Supabase client for server-side writes
│   │   │   └── tunnelWatcher.ts          # Watches cloudflared log → upserts app_config.api_url
│   │   ├── scripts/
│   │   │   └── captureIb.ts              # One-shot capture script (Batch 7 deliverable)
│   │   ├── cron/
│   │   │   ├── ibPricePoller.ts          # Real-time loop, IB-only, adaptive cadence
│   │   │   ├── finnhubPricePoller.ts     # Fallback poller, continuous, 60s
│   │   │   ├── accuracyUpdater.ts        # Daily hindsight accuracy (Batch 14b)
│   │   │   ├── lockCleanup.ts            # Stale analysis_locks cleanup (5-min TTL)
│   │   │   └── keepalive.ts              # Supabase + IB tickle
│   │   ├── middleware/
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
├── infra/
│   └── clientportal.gw/      # Fallback Dockerfile (not used in live stack; IBeam is)
├── supabase/
│   └── migrations/           # 001_initial.sql + sequential follow-ons
├── captures/                 # Raw IB JSON dumps (gitignored, Batch 7 output)
├── secrets/                  # IB credential files (gitignored)
├── docker-compose.yml        # 4 services: ib-gateway (IBeam, on-demand), api, redis, cloudflared
├── .env.example
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

### Zone Membership
```
function isInZone(pnlPercent: number, thresholdPct: number): boolean {
  return pnlPercent >= thresholdPct;
}

// On each positions write:
//   wasInZone = (priorRow.zone_entered_at !== null);
//   nowInZone = isInZone(newPnlPct, prefs.profit_zone_threshold_pct);
//   if (!wasInZone && nowInZone) {
//     zone_entered_at = now();
//     entered_zone_via_gap = (now() < todays_market_open);
//     maybeFireDiscordNotification();  // with 4h cooldown check
//   } else if (wasInZone && !nowInZone) {
//     zone_exited_at = now();
//     zone_entered_at = null;
//   }
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
