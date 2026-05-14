# Upside — Build Queue

Reference spec: UPSIDE_MVP_SPEC.md
Agent work tracking: CLAIMS.md (managed by coding agents)

## How this works
- All batches listed here are fully planned and ready to be picked up
- Dependencies are listed where they exist — the agent decides execution order
- Agents claim and track completion in separate files (CLAIMS.md, COMPLETION_LOG.md)
- Batches are designed so two agents can work on different batches simultaneously without file conflicts

---

## Batch 1: Portfolio home screen

**Scope:** Build the complete Portfolio Home screen with mock data.

Read `UPSIDE_MVP_SPEC.md`: "Screen 1: Portfolio Home", "Design System", "Key Metrics & Calculations", "Project Structure"

**Deliverables:**
1. Scaffold React + Vite + TypeScript project
2. All Portfolio Home components:
   - `PositionCard.tsx` — ticker/company, combined P&L with inline sparkline, price + today's change + VWAP indicator, portfolio weight bar at card bottom, P&L background tint scaled to magnitude, conditional signal pill row
   - `SummaryStrip.tsx` — portfolio value + MTD return
   - `SortBar.tsx` — Signals / P&L / Custom toggle pills
   - `MarketPeriodBadge.tsx` — tappable badge with exchange hours dropdown
   - `Sparkline.tsx` — inline 7-day SVG sparkline (44x20px)
   - `BottomNav.tsx` — bottom navigation (MVP tabs: Portfolio, Alerts, Settings — Watchlist and Chat removed per MVP scope)
3. Mock data file with 5-6 realistic positions
4. Dark mode via CSS variables
5. Mobile-first layout (375-390px)
6. Basic routing (react-router) with placeholder pages
7. PWA manifest + service worker shell

**Card specs:** P&L tint opacity: <1%→0.04, <5%→0.05, <10%→0.07, <20%→0.10, 20%+→0.14. VWAP: green ↑ above +0.1%, red ↓ below -0.1%, gray "= VWAP". Weight bar: horizontal at card bottom, width = portfolio %. Signal pills: Sell #FCEBEB/#501313, Buy #EAF3DE/#173404, Event #E6F1FB/#042C53. Near-zero (±1%): gray #888780.

**Files:** `client/src/components/PortfolioHome/*`, `client/src/components/common/*`, `client/src/data/mockPositions.ts`, `client/src/App.tsx`, `client/src/main.tsx`, `client/public/manifest.json`, CSS/style files

---

## Batch 2: Ticker detail — layout & static components

**Depends on:** Batch 1 (uses routing setup and shared components)

**Scope:** Ticker detail screen layout, static sections, navigation. No chart library.

Read `UPSIDE_MVP_SPEC.md`: "Screen 2: Ticker Detail"

**Deliverables:**
1. `TickerDetail.tsx` — full-screen slide-in from right, route `/ticker/:symbol`
2. Header: back arrow + ticker/company, price + today's change
3. `TodayRange.tsx` — range bar above chart with low (red) / high (green) / current price dot
4. `MarketStats.tsx` — dense 2-row stats panel above chart, customizable via inline edit panel with toggles + drag handles. Available stats: Volume, Fwd P/E, Prior close, Beta, 52w range, Open, EPS, Market cap, Dividend, Put/call, Tweet volume, Avg volume
5. Chart placeholder container (Batch 3 mounts chart here)
6. `ChartControls.tsx` — Line/Candle + VWAP/Vol/RSI toggles
7. `TimeframeBar.tsx` — scrollable pills: 30m, 2h, 1D, 2D, 1W, 1M, 3M, 1Y, 5Y, All
8. Collapsible sections (shared `CollapsibleSection.tsx`):
   - `SignalSection.tsx` — signal pill + confidence + reasoning + Style A breakdown
   - `PositionStats.tsx` — shares, avg cost, P&L, %/day, portfolio weight/contribution, days held
   - `IndicatorsSection.tsx` — RSI, VWAP, MACD, Volume, Bollinger, Earnings with status badges
9. Extended mock data for ticker details

**Files:** `client/src/components/TickerDetail/*`, `client/src/components/common/CollapsibleSection.tsx`, `client/src/data/mockPositions.ts` (extend), `client/src/App.tsx` (add route only)

**Does NOT touch:** PortfolioHome components, backend, chart library.

---

## Batch 3: Ticker detail — chart integration

**Depends on:** Batch 2 (mounts into chart placeholder)

**Scope:** Integrate Lightweight Charts into the chart placeholder.

**Deliverables:**
1. Install `lightweight-charts` (TradingView, free/open-source)
2. `PriceChart.tsx`:
   - Candlestick + line mode toggle
   - Timeframe switching via props
   - Entry price horizontal dashed line + entry date vertical marker
   - VWAP overlay (purple, toggleable)
   - RSI subchart (toggleable, overbought >70 shaded red, oversold <30 shaded green)
   - Volume bars (toggleable)
   - Touch: pinch-zoom, drag-pan
   - Dark mode compatible
3. `mockChartData.ts` — realistic OHLCV data for multiple timeframes

**Files:** `client/src/components/TickerDetail/PriceChart.tsx`, `client/src/data/mockChartData.ts`, `client/package.json` (add dependency)

**Does NOT touch:** Any other components, PortfolioHome, backend.

---

## Batch 4: Oracle VPS + Docker setup [MANUAL]

**Scope:** Manual infrastructure setup. Follow the guide in UPSIDE_MVP_SPEC.md.

### Steps:
1. Create Oracle Cloud account at https://cloud.oracle.com/ (need credit/debit card for $1 verification hold)
2. **Home Region: US-East (Ashburn)** — cannot change later
3. Create instance: Ubuntu 24.04 Minimal aarch64, VM.Standard.A1.Flex, 4 OCPU, 24 GB RAM, 200 GB boot volume, public IPv4
4. Security List ingress rules: port 443, port 80, port 22
5. SSH in: `ssh -i ~/.ssh/oracle_key ubuntu@<PUBLIC_IP>`
6. Install Docker: `curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER`
7. Install Compose: `sudo apt install docker-compose-plugin -y`
8. **Open OS firewall** (critical — Oracle iptables blocks even if security list allows):
   ```
   sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
9. Create project dir: `mkdir -p ~/upside`
10. Verify: `docker run hello-world`

**Output:** Running VPS with Docker, accessible via SSH, ports 80/443 open.

---

## Batch 5: Docker Compose + Supabase schema + Node.js API scaffold

**Depends on:** Batch 4 (VPS must exist for deployment, but code can be written before)

**Scope:** Docker config, database schema, and Node.js API scaffold. All backend code.

**Deliverables:**

1. **`docker-compose.yml`** — 3 containers:
   - `ib-gateway`: image built from `infra/clientportal.gw/Dockerfile` (created in Batch 7) — wraps IB's official **Client Portal Gateway** (Java, REST API on port 5000). **NOT** the legacy TWS Socket API (ports 4001-4004); those are a different IB product with a different auth flow. **DO NOT set any IB credential env vars** — auth happens via REST calls from Node backend that proxies user-entered credentials from browser. Port 5000 internal only. Restart unless-stopped.
   - `api`: Node.js app built from server/Dockerfile, port 3001 internal, depends on ib-gateway + redis, restart unless-stopped
   - `redis`: redis:7-alpine (ARM64 compatible), port 6379 internal only, restart unless-stopped

2. **`server/Dockerfile`** — node:22-alpine, install deps, expose 3001

3. **Node.js API scaffold (`server/src/`):**
   - `index.ts` — Express + CORS + JSON + error handling
   - `routes/auth.ts` — Upside auth + IB auth:
     - `POST /api/auth/google/callback` — handle Supabase OAuth callback, check email against `UPSIDE_ALLOWED_EMAILS` whitelist, log to `access_attempts`, redirect to https://google.com if not whitelisted
     - `POST /api/auth/ib/login` — proxy IB credentials to IB Gateway, store session token in Redis with 24h TTL keyed by user ID
     - `POST /api/auth/ib/tickle` — keepalive
     - `GET /api/auth/ib/status` — connection status
     - `POST /api/auth/ib/logout` — clear Redis session
   - `routes/portfolio.ts` — GET positions, GET summary
   - `routes/marketdata.ts` — GET snapshot/:symbol, GET history/:symbol
   - `routes/signals.ts` — POST /api/signals/analyze (with concurrency lock pattern using `analysis_locks` table)
   - `middleware/auth.ts` — JWT verification + whitelist check on every request
   - `services/ibGateway.ts` — IB Client Portal API wrapper with rate limiting
   - `services/redis.ts` — Redis client with TTL helpers
   - `services/supabase.ts` — server-side Supabase client (using service key)
   - `services/llm.ts` — provider-agnostic abstraction (interface + gemini/claude/openai implementations, selected via LLM_PROVIDER env var)
   - `services/technicals.ts` — RSI, MACD, Bollinger computation using `technicalindicators` lib
   - `services/finnhub.ts` — news, sentiment, earnings, insider trades
   - `cron/pricePoller.ts` — skeleton
   - `cron/signalRunner.ts` — skeleton (in MVP, only triggered by user — but cron handles cleanup of stale `analysis_locks` older than 60s)
   - `cron/keepalive.ts` — skeleton (IB tickle + Supabase ping)
   - `types/index.ts` — Position, Signal, MarketData, UserPreferences, AnalysisLock types

4. **Supabase schema (`supabase/migrations/001_initial.sql`):**
   - `positions` table (symbol, shares, avg_cost, current_price, market_value, pnl, vwap, etc.)
   - `signals` table — UPDATED: range-based with separate metrics:
     - `signalType` ('sell' | 'no_signal') — MVP scope (BUY post-MVP)
     - `signalQuality` (0-100, LLM confidence in analysis, stable per signal)
     - `priceRangeLow`, `priceRangeHigh` (null if no_signal)
     - `optimalPrice` (the HIGH of range for sell, LOW for buy post-MVP)
     - `reasoning` (overall summary text)
     - `indicatorBullets` (JSONB array of per-indicator short rationales)
     - `indicatorSnapshot` (JSONB snapshot of all indicator values at analysis time)
     - `actualMaxSinceAnalysis` / `actualMinSinceAnalysis` (live-updated for accuracy tracking)
     - `enteredRangeAt`, `exitedRangeAt` (timestamps)
     - `supersededByAnalysisId` (null if current, else points to newer analysis)
     - `analyzedAt`, `expiresAt`
   - `user_preferences` table (signal_threshold, signal_min_market_value default 1000, suppressed_symbols, sort order, stat config, theme, quiet hours start/end, llm_provider)
   - `position_history` table (daily snapshots)
   - `analysis_locks` table — for concurrency control:
     - `{ id, symbol, user_id, started_at, status: 'running' | 'failed' }`
     - Auto-cleanup cron deletes locks older than 60 seconds (assumed crashed)
   - `access_attempts` table — for whitelist enforcement logging:
     - `{ id, email, granted: bool, ip_address, user_agent, attempted_at }`
   - Realtime enabled on `positions`, `signals`, `analysis_locks` tables
   - Row Level Security on all user-data tables

5. **`.env.example`** — all required env vars documented (NO actual values, only placeholders):
   ```
   # Upside auth whitelist
   UPSIDE_ALLOWED_EMAILS=email1@gmail.com,email2@gmail.com

   # Supabase
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-anon-key
   SUPABASE_SERVICE_KEY=your-service-role-key

   # Google OAuth (Supabase handles, but client ID needed)
   GOOGLE_OAUTH_CLIENT_ID=...

   # LLM provider (gemini | claude | openai)
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=...
   ANTHROPIC_API_KEY=
   OPENAI_API_KEY=

   # External data sources
   FINNHUB_API_KEY=...

   # Internal
   IB_GATEWAY_URL=http://ib-gateway:5000
   REDIS_URL=redis://redis:6379
   PORT=3001
   NODE_ENV=production
   ```
   NOTE: IB credentials are NEVER in env vars. They're entered by user in browser, stored only in user's password manager. Backend proxies them at login time, stores resulting session token in Redis with 24h TTL.

**Files:** `docker-compose.yml`, `server/**`, `supabase/**`, `.env.example`

**Does NOT touch:** Any client/ files.

---

## Batch 6: Schema reconciliation + IB mappers + snapshot fix

**Depends on:** Batch 5 (initial schema + scaffold) + Batch 7 (raw IB captures)

**Scope:** Align our schema, types, and IB gateway code with what IB actually returns. Code-only — no live wiring, no Supabase project required at this stage. Driven by the gap analysis produced from Batch 7's `captures/` directory.

**Why this is its own batch:** the original Batch 6 ("real-time price loop + frontend wiring") assumed our schema and types were correct. The Batch 7 captures showed several material gaps (missing `conid` column, wrong snapshot field codes, missing subscribe-wait-fetch pattern, missing company_name source). Building the live-wiring batch on top of those assumptions would force a painful rewrite. This batch fixes the foundation first.

**Deliverables:**

1. **`supabase/migrations/002_align_with_ib.sql`** — adjustments to existing tables:
   - `positions`: add `conid bigint not null`, `account_id text not null`, `currency text not null default 'USD'`, `asset_class text not null default 'STK'`, `industry text`, `category text`, `realized_pnl numeric`, `underlying_conid bigint`.
   - `signals`: add `conid bigint` (store at analysis time, avoid re-resolving).
   - Optional: new `contracts` cache table keyed by `conid` with `company_name`, `industry`, `category`, `currency`, `exchange`, etc. — populated lazily, refreshed periodically.

2. **`server/src/types/index.ts` + `client/src/types/index.ts`** — extend `Position` with `conid`, `accountId`, `currency`, `assetClass`, `industry`, `category`. Adjust which fields are nullable based on what's computable vs. what's only available after snapshot. Add `RawIbPosition`, `RawIbContractInfo`, `RawIbSnapshot`, `RawIbHistoryBar` types reflecting IB's actual response shapes.

3. **`server/src/services/ibMappers.ts`** — typed transformers:
   - `ibPositionToPosition(raw, contractInfo, snapshot, portfolioTotal) → Position`
   - `ibSnapshotToMarketSnapshot(raw) → MarketSnapshot`
   - `ibHistoryToOhlcBars(raw) → OhlcBar[]` (rename `o/h/l/c/v/t` → standard fields, divide `t` by 1000)
   - `pickPrimarySecdefResult(results) → { conid }` — heuristic for symbol→conid disambiguation, preferring NYSE/SMART/NASDAQ.

4. **`server/src/services/ibGateway.ts`** rewrite of `ibSnapshot`:
   - First call to `/snapshot` subscribes (returns only `{ conidEx, conid }`).
   - Wait ~1s (or poll until populated, max 5 retries).
   - Return the populated response.
   - Re-verify field codes against IB docs; correct ones for: last price (31), today high (70), today low (71), today change % (82), today change $ (83), bid (84), open (85), ask (86), volume (87), prior close (88). VWAP isn't in standard snapshot; document how to obtain it (likely from `/iserver/marketdata/snapshot` with a different field code OR computed from history bars).

5. **Re-run capture** (`pnpm --filter server capture`) after the snapshot fix to verify fields are actually populated. Should produce a second batch of `snapshot-*.json` files with real data.

**Verification:**
- `pnpm -r typecheck` clean.
- Migration `002_align_with_ib.sql` is reviewable; no execution against a Supabase project required here (deferred to Batch 8).
- Re-capture confirms snapshot endpoints now return populated fields.

**Files:** `supabase/migrations/002_align_with_ib.sql`, `server/src/types/index.ts`, `client/src/types/index.ts`, `server/src/services/ibMappers.ts`, `server/src/services/ibGateway.ts` (snapshot fix).

**Does NOT touch:** Any client/ UI components, `cron/*`, or `routes/*` (except indirect type updates). No FE wiring, no Supabase deploy.

---

## Batch 7: Raw IB Client Portal data capture

**Scope:** Capture real Interactive Brokers data from a live account, locally, so we can validate every type/schema we've written so far against IB reality before building Batch 6 (the live wiring) on potentially-wrong assumptions.

**Why this exists:** The `Position`, `Signal`, `MarketSnapshot`, `OhlcBar` types in `server/src/types/index.ts` + `client/src/types/index.ts`, the `positions`/`signals` columns in `supabase/migrations/001_initial.sql`, and the field-code list in `server/src/services/ibGateway.ts` were all derived from spec assumptions about IB's API shapes. We don't actually know what IB returns until we look. This batch makes us look.

**Approach — local, no infrastructure:**
1. Run IB Client Portal Gateway (Java zip from interactivebrokers.com, NOT Docker — our compose image is wrong for REST anyway) on the dev laptop.
2. Authenticate via the gateway's web UI at `https://localhost:5000` with **live** IBKR Pro credentials + 2FA push.
3. Run `scripts/captureIb.ts` to sweep every IB endpoint our backend code expects to use, one call per endpoint per parameter set, each call writing its own JSON file to `captures/` (gitignored). Errors captured to `*.error.json` so we learn what we can't yet get.
4. Claude reads the captured JSON files, produces a field-by-field gap analysis between our current types/schema and IB reality.

**Out of scope (deferred to a later batch):**
- Migration 002, type updates, IB mappers — those are downstream of the analysis.
- Fixture layer for the FE — also downstream.
- Fixing `docker-compose.yml` which currently references `ghcr.io/gnzsnz/ib-gateway` (TWS Socket API, ports 4001-4004) instead of a Client Portal Gateway image. Track this as a server-side followup.

**Deliverables:**
1. `scripts/captureIb.ts` — Node + tsx script targeting `https://localhost:5000`, no env vars needed. Captures: `/v1/api/iserver/accounts`, `/v1/api/portfolio/<acctId>/positions/0`, `/v1/api/iserver/secdef/search?symbol=<SYM>` per held symbol, `/v1/api/iserver/marketdata/snapshot?conids=<id>&fields=...` per conid, `/v1/api/iserver/marketdata/history?conid=<id>&period=<p>&bar=<b>` per (conid, timeframe), `/v1/api/iserver/contract/<conid>/info` per conid, `/v1/api/tickle`, `/v1/api/iserver/auth/status`. One file per call. Errors written as `<name>.error.json`. Doesn't stop on errors.
2. `captures/` directory at repo root, gitignored.
3. `.gitignore` entry — `captures/`.
4. **Manual step:** user downloads clientportal.gw zip from IB, unzips, runs `bin/run.sh root/conf.yaml`, logs in via browser. Requires `default-jre` installed on WSL2.
5. **Manual step:** after capture, user pastes `ls captures/ | wc -l` and any error file names back into the conversation so Claude can pull the relevant files and analyze.

**Files this batch creates/edits:** `scripts/captureIb.ts`, `.gitignore` (add `captures/`).

**Does NOT touch:** `server/`, `client/`, `supabase/`, `docker-compose.yml`, types, or any production code path. Pure capture + analysis.

**Verification:**
- `java --version` succeeds in WSL2.
- `bin/run.sh root/conf.yaml` boots without errors.
- `curl -sk https://localhost:5000/v1/api/iserver/auth/status` returns `{ "authenticated": true, "connected": true, ... }`.
- After running `pnpm tsx scripts/captureIb.ts`: `ls captures/` shows >N files where N = number of held symbols.
- `grep -r "<your-live-username>" captures/` returns nothing (credentials never written).
- Claude produces a written gap analysis in conversation.

---

## Batch 8: Supabase project provisioning [MANUAL]

**Scope:** Create the actual Supabase project, apply migrations, save credentials. You do this manually; no agent claim, no agent code.

**Why MANUAL:** Same reason Batch 4 (Oracle VPS) is manual — it's infrastructure that requires an account, a UI, and one-time credential handling. Agents shouldn't be holding service-role keys.

### Steps:
1. Create Supabase account at https://supabase.com if not already.
2. New project → name `upside-prod` (or whatever) → choose closest region to Oracle VPS (US East 1 / Virginia matches Ashburn well).
3. In SQL Editor, paste and run `supabase/migrations/001_initial.sql`.
4. In SQL Editor, paste and run `supabase/migrations/002_align_with_ib.sql` (from Batch 6).
5. Project Settings → API → copy:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_ANON_KEY` (anon / public key)
   - `SUPABASE_SERVICE_KEY` (service_role key — secret)
6. Authentication → Providers → enable Google OAuth (will need a Google Cloud OAuth client; defer until Batch 9 if you want).
7. Save all three values somewhere I can read them when filling `.env` (NEVER commit them).
8. Verify: SQL Editor → `select count(*) from positions, signals, user_preferences, position_history, analysis_locks, access_attempts;` returns 0s without error.

**Output:** Live Supabase project, migrations applied, three credentials in hand.

**Does NOT touch:** Any repo files. This is purely a Supabase Cloud setup.

---

## Batch 9: Real-time price loop + frontend wiring

**Depends on:** Batch 1 + Batch 5 + Batch 6 + Batch 8

**Scope:** Implement real-time polling, connect frontend to live Supabase data instead of mock data. Builds on the reconciled schema from Batch 6 and the provisioned Supabase project from Batch 8.

**Deliverables:**

### Backend:
1. `cron/pricePoller.ts` — full implementation: poll IB every 5-15s during market hours, cache Redis, write Supabase only on change, handle rate limits + session expiry. Uses the fixed `ibSnapshot` (subscribe-wait-fetch) and the new `ibMappers.ts` from Batch 6.
2. `cron/keepalive.ts` — IB tickle every 30s, Supabase ping every 4h.
3. `utils/marketHours.ts` — detect pre-market/regular/after-hours/closed based on ET, weekends, US market holidays.

### Frontend:
4. `services/supabase.ts` — client initialization (uses anon key + `VITE_SUPABASE_URL` env).
5. `hooks/usePositions.ts` — replace mock data with REST fetch + Supabase Realtime subscription. When Supabase notifies positions changed → pull fresh data from Supabase (source of truth).
6. `hooks/useSignals.ts` — Supabase Realtime on signals table → pull updated signal on change.
7. `hooks/useMarketSession.ts` — polls `/api/auth/status` every 30s, returns `{ session: 'connected' | 'expired' | 'disconnected', marketPeriod: 'pre-market' | 'regular' | 'after-hours' | 'closed' }`.
8. Update PositionCard, SummaryStrip, Sparkline to accept real data props.
9. Sparkline fetches 7-day bars from `/api/marketdata/history/:symbol`.

### Connection status in header (always visible):
- A small status dot in the header (next to the market period badge) shows IB connection state at all times.
- `connected` → green dot, no text.
- `disconnected` → amber dot + "Reconnecting..." text, retrying silently in background.
- `expired` → red dot + "Session expired" text.
- On reconnect success → dot returns to green automatically.

### Session expired — full UI block:
- When app opens and IB session is expired, the entire UI is replaced with a full-screen reconnect prompt (not a banner).
- Shows: Upside logo, "Your IB session has expired" message, "Reconnect" button.
- On tap: proxies credentials to IB gateway → waits for 2FA approval on IB Key app → animated "Waiting for approval..." state → on success, dismisses block and loads portfolio.
- Cached data is NOT shown beneath the block — session must be restored before portfolio is visible.

### Mid-session IB failure (hiccup):
- Real-time loop retries silently up to 3 times with exponential backoff.
- Header dot changes to amber "Reconnecting..." immediately on first failure.
- If restored within retries → dot returns to green, no disruption to UI.
- If all retries fail → dot turns red "Session expired" → user taps dot to trigger reconnect flow (same flow as above but as a non-blocking side sheet, not full-screen block, since user already has data loaded).

**Note on shared types:** the `Position` / `Signal` / `IndicatorSnapshot` / `MarketPeriod` / `SessionStatus` types this batch consumes are already defined and reconciled with IB reality in Batch 6 (`server/src/types/index.ts`, `client/src/types/index.ts`). Don't redefine; import.

**Files:** `server/src/cron/*`, `server/src/utils/marketHours.ts`, `client/src/services/supabase.ts`, `client/src/hooks/*`, updates to PortfolioHome components.




