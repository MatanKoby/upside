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
   - `SignalSection.tsx` — signal pill + Quality + reasoning + Style A breakdown
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
   - `position_history` table (daily snapshots) — **NOTE:** dropped in Batch 14.5 since it never had a real consumer.
   - `analysis_locks` table — for concurrency control:
     - `{ id, symbol, user_id, started_at, status: 'running' | 'failed' }`
     - Auto-cleanup cron deletes locks older than 60 seconds (assumed crashed) — **NOTE:** raised to 5 min in Batch 14a.
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
   SUPABASE_PUBLISHABLE_KEY=your-publishable-key
   SUPABASE_SECRET_KEY=your-secret-key

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

**Approach — local Docker, no infrastructure:**
1. Build IB Client Portal Gateway image from `infra/clientportal.gw/Dockerfile` (wraps IB's official `clientportal.gw.zip`). `docker run --rm -p 127.0.0.1:5000:5000` on dev laptop.
2. Authenticate via the gateway's web UI at `https://localhost:5000` (incognito tab, accept the IB self-signed cert) with **live** IBKR Pro credentials + 2FA push.
3. Run `server/scripts/captureIb.ts` to sweep every IB endpoint our backend code expects to use, one call per endpoint per parameter set, each call writing its own JSON file to `captures/` (gitignored). Errors captured to `*.error.json` so we learn what we can't yet get.
4. Claude reads the captured JSON files, produces a field-by-field gap analysis between our current types/schema and IB reality.

**Out of scope (deferred to a later batch):**
- Migration 002, type updates, IB mappers — those are downstream of the analysis (Batch 6).
- Fixture layer for the FE — also downstream.

**Deliverables:**
1. `infra/clientportal.gw/Dockerfile` — wraps IB's official `clientportal.gw.zip` (Java REST API on port 5000). Patches `conf.yaml` to allow Docker bridge IPs.
2. `server/scripts/captureIb.ts` — Node + tsx script targeting `https://localhost:5000`, runs via `pnpm --filter server capture`. Captures: `/v1/api/iserver/accounts`, `/v1/api/portfolio/<acctId>/positions/0`, `/v1/api/iserver/secdef/search?symbol=<SYM>` per held symbol, `/v1/api/iserver/marketdata/snapshot?conids=<id>&fields=...` per conid, `/v1/api/iserver/marketdata/history?conid=<id>&period=<p>&bar=<b>` per (conid, timeframe), `/v1/api/iserver/contract/<conid>/info` per conid, `/v1/api/tickle`, `/v1/api/iserver/auth/status`. One file per call. Errors written as `<name>.error.json`. Doesn't stop on errors.
3. `captures/` directory at repo root, gitignored.
4. `.gitignore` entry — `captures/`.
5. **Manual step:** `docker build -t upside/clientportal.gw infra/clientportal.gw && docker run --rm -p 127.0.0.1:5000:5000 --name cpg upside/clientportal.gw`, then browser login.
6. **Manual step:** after capture, user pastes `ls captures/ | wc -l` and any error file names back into the conversation so Claude can pull the relevant files and analyze.

**Files this batch creates/edits:** `infra/clientportal.gw/Dockerfile`, `infra/clientportal.gw/README.md`, `server/scripts/captureIb.ts`, `server/tsconfig.scripts.json`, `server/package.json` (capture script alias), `.gitignore` (add `captures/`, anchor `clientportal.gw/` to root).

**Side effect — bug fix:** This batch's investigation revealed the existing `docker-compose.yml` referenced the wrong image (`ghcr.io/gnzsnz/ib-gateway-docker` is TWS Socket API on ports 4001-4004, NOT Client Portal REST on 5000 which our code targets). The wrong service was commented out and pointed at the new `infra/clientportal.gw/Dockerfile` for the eventual deploy. Spec was untouched (it was correct).

**Verification:**
- `docker build -t upside/clientportal.gw infra/clientportal.gw` succeeds.
- `docker run --rm -p 127.0.0.1:5000:5000 --name cpg upside/clientportal.gw` runs without error.
- `curl -sk https://localhost:5000/v1/api/iserver/auth/status` returns `{ "authenticated": true, "connected": true, ... }` after browser login.
- After `pnpm --filter server capture`: `ls captures/` shows >N files where N = number of held symbols.
- `grep -r "<your-live-username>" captures/` returns nothing (credentials never written).
- Claude produces a written gap analysis in conversation.

---

## Batch 7.5: Collapse migrations into single baseline

**Depends on:** Batch 6 (must have written migration 002 before there's anything to collapse).

**Scope:** Before we apply any SQL to a real Supabase project, fold the contents of `supabase/migrations/002_align_with_ib.sql` directly into `supabase/migrations/001_initial.sql` so that the on-disk schema is a single source-of-truth file. Delete `002_align_with_ib.sql`.

**Why:** We're pre-deploy. There's no production data to preserve through a migration sequence. The 001/002 split was useful as an audit trail of "what we learned from Batch 7 captures" — but that history is already captured in git log + `CLAIMS.md` + `BUILD_QUEUE.md`. The on-disk file should reflect the *current intended schema*, not the history of how we got there.

After this batch, future schema changes (post-Supabase-deploy) become real sequential migrations (`002`, `003`, etc.) with the proper "alter existing" semantics. The pre-deploy collapsing only happens once.

**Deliverables:**
1. Edit `supabase/migrations/001_initial.sql` to incorporate all changes from `002_align_with_ib.sql` (positions columns, signals.conid, contracts table, ib_api_metrics table). Existing 001 table definitions get the new columns added inline rather than via `alter table`.
2. Delete `supabase/migrations/002_align_with_ib.sql`.
3. Verify by reading the consolidated 001 top-to-bottom — every table fully specified, no `alter` statements remain.

**Files:** `supabase/migrations/001_initial.sql` (rewrite), `supabase/migrations/002_align_with_ib.sql` (delete).

**Does NOT touch:** Any code, types, mappers, FE. Pure SQL housekeeping.

---

## Batch 8: Supabase project provisioning [MANUAL]

**Scope:** Create the actual Supabase project, apply migrations, save credentials. You do this manually; no agent claim, no agent code.

**Why MANUAL:** Same reason Batch 4 (Oracle VPS) is manual — it's infrastructure that requires an account, a UI, and one-time credential handling. Agents shouldn't be holding service-role keys.

### Steps:
1. Create Supabase account at https://supabase.com if not already.
2. New project → name `upside-prod` (or whatever) → choose closest region to Oracle VPS (US East 1 / Virginia matches Ashburn well).
3. In SQL Editor, paste and run `supabase/migrations/001_initial.sql` (single baseline file post-Batch-7.5; if Batch 7.5 hasn't run yet, also apply `002_align_with_ib.sql` after).
5. Project Settings → API → copy:
   - `SUPABASE_URL` (Project URL)
   - `SUPABASE_PUBLISHABLE_KEY` (publishable / public key)
   - `SUPABASE_SECRET_KEY` (secret key — keep private)
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

**Verification pending from spec — resolve in this batch:**
- `tradingDaysHeld` source. Spec intends to derive this from IB's transactions endpoint (`/v1/api/portfolio/<acctId>/transactions` or equivalent). Confirm the endpoint exists, the response shape gives us entry dates, and that it works for older positions. If unreliable, fall back to Upside-tracked entry-date (mark older positions as "≥N days" until next change-in-shares event).
- MTD return source. Spec intends to pull MTD from IB's account summary endpoint. Confirm endpoint name + response field. If absent, compute from a Redis-cached portfolio-value snapshot taken at the start of each month.

**Files:** `server/src/cron/*`, `server/src/utils/marketHours.ts`, `client/src/services/supabase.ts`, `client/src/hooks/*`, updates to PortfolioHome components.

---

## Batch 10: Deploy BE compose stack to Oracle VPS [partly MANUAL]

**Depends on:** Batch 8 (Supabase exists) + Batch 9 (pricePoller implemented).

**Scope:** Get the production compose stack running on the Oracle VPS. This is the first time `docker compose up -d` runs in production.

### Steps:
1. SSH into VPS: `ssh upside-vps`.
2. `cd ~/upside && git clone git@github.com:MatanKoby/upside.git .` (first deploy only), or `git pull origin dev` on subsequent deploys.
3. Build the IB gateway image: `docker build -t upside/clientportal.gw infra/clientportal.gw`.
4. Create `~/upside/.env` from `.env.example` with real values: Supabase URL/anon/service keys (from Batch 8), `UPSIDE_ALLOWED_EMAILS=matankoby88@gmail.com`, `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` (post-Batch-14), `FINNHUB_API_KEY` (post-Batch-14). NEVER commit this file.
5. Edit `docker-compose.yml` to un-comment the `ib-gateway` service block (it was commented out in Batch 7 because the original image reference was wrong).
6. `docker compose up -d --build`.
7. Verify: `docker compose ps` shows 3 containers Up. `curl http://localhost:3001/healthz` returns `{"ok":true,"env":"production"}`. `docker compose logs api --tail 100` shows no errors.
8. **Do not yet authenticate IB** — that happens on the FE once Batch 13 is live.

**Output:** Stack running on VPS, healthcheck passes, no IB session yet (intentional — auth flow lives in FE).

**Files this batch creates/edits:** `docker-compose.yml` (un-comment ib-gateway service).

**Verification:**
- `docker compose ps` on VPS shows `cpg`, `api`, `redis` all Up.
- `curl http://localhost:3001/healthz` returns expected JSON.
- Supabase Dashboard → SQL → `select count(*) from positions` returns 0 (table exists, BE can talk to it).

---

## Batch 11: Self-healing Cloudflare Quick Tunnel + FE URL bootstrap

**Depends on:** Batch 10.

**Scope:** Expose the api container over HTTPS via a Cloudflare Quick Tunnel (free, no domain), and build the self-healing URL discovery mechanism so the FE recovers automatically when the tunnel URL changes. Architectural rationale lives in UPSIDE_MVP_SPEC.md → "Public URL Discovery (self-healing Quick Tunnel)".

### Backend / infra deliverables

1. **`docker-compose.yml`** — add `cloudflared` as a fourth service:
   - Image: `cloudflare/cloudflared:latest` (or a pinned tag).
   - Command: `tunnel --no-autoupdate --url http://api:3001 --logfile /var/log/cloudflared/cloudflared.log`. **`--no-autoupdate` is required** — auto-update reassigns the Quick Tunnel URL on every (≈daily) self-update.
   - Volume: named volume `cloudflared-logs` mounted at `/var/log/cloudflared`. Also mount the same volume into the `api` container read-only at the same path.
   - `depends_on: [api]`, `restart: unless-stopped`, on the existing `upside` network.

2. **`supabase/migrations/002_app_config.sql`** — new key/value runtime config table:
   - `app_config { key text primary key, value text not null, updated_at timestamptz not null default now() }`.
   - RLS enabled. Policies: `select` open to `anon` + `authenticated`; `insert`/`update`/`delete` only for service role.
   - Realtime publication enabled on this table.
   - User applies via Supabase SQL Editor (same manual pattern as Batch 8).

3. **`server/src/services/tunnelWatcher.ts`** — background task in the api:
   - On startup: read `/var/log/cloudflared/cloudflared.log` and parse for the current Quick Tunnel URL (line containing `trycloudflare.com`).
   - Subscribe to file changes via `fs.watch` with a 30s polling fallback (Docker volume + `fs.watch` events can be unreliable across recreations).
   - On any URL distinct from the last-known value, upsert into `app_config` keyed `api_url`.
   - Log each detection + upsert at INFO level.
   - Started from `server/src/index.ts` once the supabase service-role client is ready; runs forever.

4. **`.env.example` cleanup** — note that no `VITE_API_URL` is needed on Vercel; the FE discovers the api URL from `app_config` at runtime.

### Frontend deliverables

5. **`client/src/services/apiUrl.ts`** — bootstrap utility:
   - `getApiUrl()`: returns the current api URL. Lookup order: (a) in-memory cache, (b) `localStorage` (key `upside_api_url`), (c) Supabase `app_config.api_url`. If all three miss, throws.
   - On successful Supabase fetch, populates both caches.
   - `subscribeToApiUrl()`: wires up a Supabase Realtime channel on `app_config`; on `UPDATE` events where `key='api_url'`, refreshes both caches.

6. **`client/src/services/api.ts`** (or the existing fetch helpers) — base URL for backend calls comes from `getApiUrl()`. On a network-class fetch failure, clears both caches and re-fetches from Supabase as a recovery step before retrying once.

7. **`client/src/App.tsx`** (top-level mount) — call `subscribeToApiUrl()` on mount; tear down on unmount.

8. **Remove any `VITE_API_URL` references** from FE code. Single source of truth is now `app_config`.

### Verification

1. `docker compose up -d --build` on VPS → four containers Up.
2. `docker compose logs cloudflared --tail 30` → shows `Your quick Tunnel has been created! ... https://<random>.trycloudflare.com`.
3. `docker compose logs api --tail 30 | grep -i tunnel` → watcher logs the detected URL and the upsert.
4. Supabase SQL Editor: `select * from app_config` → one row, `key='api_url'`, value matches the cloudflared log.
5. From a laptop: `curl https://<URL-from-supabase>/healthz` returns `{"ok":true,"env":"production"}`.
6. **Self-healing test** (the critical one for this batch):
   ```bash
   # Terminal 1 — watcher logs
   docker compose logs api -f | grep -i tunnel
   # Terminal 2 — trigger
   docker compose restart cloudflared
   ```
   Within ~15s, Supabase `app_config.api_url` reflects the new URL. With the FE open in a browser, observe (dev tools → Network) requests transition from the old URL to the new one without manual intervention.

### Files this batch creates/edits

- `docker-compose.yml` (add `cloudflared` service + named volume + api volume mount)
- `supabase/migrations/002_app_config.sql` (new)
- `server/src/services/tunnelWatcher.ts` (new)
- `server/src/index.ts` (start the watcher)
- `client/src/services/apiUrl.ts` (new)
- `client/src/services/api.ts` (use new bootstrap; recovery on network error)
- `client/src/App.tsx` (mount subscription)
- `.env.example` (document that `VITE_API_URL` is intentionally absent)

### Does NOT touch

- Signal, portfolio, auth, market-data routes
- IB gateway service or its client code
- Any other Supabase tables

### Manual steps (user)

- A Cloudflare account is **not** required for Quick Tunnels (`cloudflared tunnel --url ...` works anonymously). Only sign up if you later want a dashboard view of metrics.
- Apply `002_app_config.sql` via the Supabase SQL Editor.

---

## Batch 12: Google OAuth end-to-end [MANUAL + code]

**Depends on:** Batch 8 (Supabase Auth provider config requires the project) + Batch 11 (Vercel FE will call the public BE URL).

**Scope:** Real Google sign-in works in the FE; whitelist enforcement bounces non-allowed emails to google.com; the BE `requireAuth` middleware exercises against actual Supabase JWTs.

### Steps:
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth 2.0 Client ID. Type: Web. Authorized redirect URIs: `https://<your-supabase-ref>.supabase.co/auth/v1/callback`. Save Client ID + Client Secret.
2. Supabase Dashboard → Authentication → Providers → Google → paste Client ID + Secret, enable.
3. In Supabase → Authentication → URL Configuration → set Site URL and additional redirect URLs to the future Vercel URL (placeholder OK if not yet deployed; can be updated post-Batch-13).
4. Client code:
   - New `client/src/pages/Login.tsx` with single "Continue with Google" button → calls `supabase.auth.signInWithOAuth({ provider: 'google' })`.
   - Wrap the app router in an `<AuthGuard>` that:
     - Reads Supabase session from `client/src/services/supabase.ts`.
     - If no session → render `<Login />`.
     - If session present → call `POST /api/auth/google/callback` (existing route in `server/src/routes/auth.ts:14`) with the access token; on `not_whitelisted`, sign out + redirect to `https://google.com`.
     - On success → render the protected app.
   - Persist Supabase session via Supabase JS SDK defaults (localStorage with auto-refresh).
   - All authenticated FE API calls include `Authorization: Bearer <access_token>` header.
5. Test end-to-end: sign in with the whitelisted email → land on portfolio home. Sign in with any other Gmail → bounced to google.com.

**Files this batch creates/edits:** `client/src/pages/Login.tsx`, `client/src/components/common/AuthGuard.tsx`, `client/src/routes.tsx` (mount AuthGuard), `client/src/services/supabase.ts` (already created in Batch 9), small additions to API call helpers to include auth header.

**Verification:**
- Vercel build of FE picks up env vars `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Logging in with `matankoby88@gmail.com` lands you on the portfolio home.
- Logging in with any other Gmail returns 403 from `/api/auth/google/callback` and the FE redirects to google.com.
- `access_attempts` Supabase table shows a row per attempt (granted=true and granted=false).
- BE-protected routes (e.g. `GET /api/portfolio/positions`) return 401 without a Bearer token and 200 with a valid whitelisted one.

---

## Batch 13: Vercel FE deploy [MANUAL + code]

**Depends on:** Batches 10, 11, 12.

**Scope:** Deploy the React PWA to Vercel so the live app is reachable from your phone.

### Steps:
1. Create a Vercel account (Sign in with GitHub) if you don't have one.
2. New Project → Import the `upside` repo.
3. **Root Directory: `client`** (this matters — see "pitfalls" below).
4. Build settings should auto-detect Vite (`pnpm build`, output `dist`). Don't manually override Install / Build / Output commands.
5. Environment variables:
   - `VITE_SUPABASE_URL` = from Batch 8
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = from Batch 8
   - `ENABLE_EXPERIMENTAL_COREPACK` = `1` (see "pitfalls" below — required to honor `packageManager` field; without it Vercel ships its bundled pnpm 6 which can't read our v9 lockfile).
   - **No `VITE_API_URL`** — the api's public URL is discovered at runtime from Supabase `app_config` (Batch 11). See UPSIDE_MVP_SPEC.md → "Public URL Discovery".
6. Trigger first deploy. Should produce a `*.vercel.app` URL.
7. **After first deploy succeeds**, update Supabase → Authentication → URL Configuration:
   - Site URL: the Vercel URL (e.g. `https://upside-client.vercel.app`).
   - Redirect URLs: add `https://<your-vercel>.vercel.app/**` (keep `http://localhost:5173/**` for local dev).
   Without this the OAuth redirect from Google → Supabase → Vercel origin is refused.
8. Test on phone: Safari → open the Vercel URL → "Add to Home Screen" → PWA installs.

### Pitfalls hit during first deploy (documented so the next agent doesn't redo)
- **Vercel uses Root Directory's `package.json`, not the workspace root's.** With Root Directory = `client`, Vercel reads `client/package.json` for `packageManager` / `engines`. We had to mirror both into `client/package.json` (they were only in the root).
- **Vercel ships pnpm 6.35.1 (from 2021) bundled.** Our pnpm-lock.yaml is v9.0 (pnpm 11). They're incompatible — pnpm 6 prints "Ignoring not compatible lockfile" and then fails. The only clean fix is enabling Corepack via `ENABLE_EXPERIMENTAL_COREPACK=1` so the project's `packageManager: "pnpm@11.0.9"` is honored.
- **pnpm 11 requires Node ≥22.13** — set `engines.node: "22.x"` in `client/package.json` to match. (Earlier tries set 20.x to dodge an unrelated `ERR_INVALID_THIS` bug that was actually pnpm-6-on-Node-24, not pnpm-11.)
- **A stray `client/package-lock.json` is a deploy-blocker once Corepack is enabled** — Vercel sees it, concludes "the project uses npm," and refuses to mix npm + pnpm. Delete it.
- **Don't override Install / Build commands in Vercel UI or in `vercel.json`** — declarative `package.json` (`packageManager` + `engines`) is sufficient and survives Vercel UI churn. No `vercel.json` needed for a Vite project.

### IB login redesign — also lands in this batch
Four approaches tried before landing on IBeam. Documented here for institutional memory:

1. **Programmatic credential POST** to `/v1/api/iserver/auth/ssodh/init` from `server/src/services/ibGateway.ts:ibLogin` — gateway returned 401. That endpoint is for SSO redirection from the gateway's own UI, not direct password auth.
2. **api-side path proxy `/ib-portal/*`** → `https://ib-gateway:5000/*` using `http-proxy-middleware`. IB Gateway's HTML returns absolute paths (`/sso/Login`, `/css/…`) which bypassed the prefix and 404'd from the api router.
3. **Second dedicated Quick Tunnel to the gateway** — gave the gateway its own public origin so absolute paths worked. Browser-side login appeared to succeed ("Client login succeeds"), but the gateway's `/v1/api/iserver/auth/status` from inside the compose network still returned 401. Cookie/Host-header round-tripping through Quick Tunnels does not carry the session cleanly.
4. **IBKR OAuth 1.0a Extended** (cleanest long-term) — server-to-server auth, no gateway container, no credentials on VPS. Implemented on `oauth-dev` branch (commit `4d7a822`). Blocked on IBKR-side activation that retail users must request via email and may wait days-to-weeks for. Parked.

**Landing approach: on-demand IBeam** ([voyz/ibeam:0.5.11](https://hub.docker.com/r/voyz/ibeam)). Replaces the bare `ib-gateway` container, but runs **only when the user explicitly turns it on from the Upside FE** — IBKR's single-session limit means a permanently-running IBeam would constantly fight the user's IBKR Mobile sessions for the same account. The api code is unchanged — it still talks to `https://ib-gateway:5000/v1/api/…` over the compose network when the container is running.

Implementation steps:

1. **Replace `ib-gateway` compose service**: image `voyz/ibeam:0.5.11`, mount credential files from VPS host. IBeam reads them via `IBEAM_SECRETS_SOURCE=fs`.
2. **Mark `ib-gateway` as on-demand**: `profiles: [manual]` so `docker compose up` does **not** auto-start it. `IBEAM_RESTART_FAILED_SESSIONS=False` and `IBEAM_AUTHENTICATION_STRATEGY=A` so even when running, IBeam doesn't fight to re-claim a contested session.
3. **Drop `cloudflared-ib` compose service** — no more external exposure of the gateway needed; IBeam handles login internally.
4. **Pin the compose network to a `10.x` subnet** so the gateway's default `ips.allow` (which includes `10.*`) accepts requests from the api container. Without this, the gateway returns "404 Access Denied" to every internal call.
5. **Mount Docker socket on api**: `/var/run/docker.sock` read-write into the api container so the api can start/stop the `ib-gateway` container via the host's Docker daemon. Accepted security trade-off for single-user MVP.
6. **BE: dockerode integration**: install `dockerode`; add `POST /api/auth/ib/connect` and `POST /api/auth/ib/disconnect` routes that start/stop the `ib-gateway` container. Update `GET /api/auth/status` to recognize a new `stopped` state (container not running) so the FE can render the Connect button instead of treating it as `expired`.
7. **Simplify `tunnelWatcher.ts`** — back to a single watcher for `api_url` only.
8. **Drop `CLOUDFLARED_IB_LOG_PATH` env** from api service.
9. **FE: cached-first model**: drop the full-screen `IBReconnectBlock` takeover entirely. Always render the portfolio screen. Header gets a small IB status indicator that shows state (`stopped`/`connecting`/`connected`/`disconnected`) and is tappable for connect/disconnect. While connecting, show "Approve 2FA push on IB Key app" and poll `/api/auth/status` every ~3s until state stabilizes.
10. **Drop `getIbPortalUrl` + `ib_portal_url` realtime subscription** from `client/src/services/apiUrl.ts`.
11. **Manual step**: user creates `~/upside/secrets/ib_account.txt` and `~/upside/secrets/ib_password.txt` on the VPS, mode `0400`. Files mounted into the IBeam container at `/run/secrets/`.
12. **Manual step**: in Supabase SQL Editor, `delete from app_config where key='ib_portal_url';` to clear the now-stale row.
13. **Deploy via `./bin/upside up`** (bash script, no Node required — works on the VPS which doesn't have npm/pnpm installed). The script does `docker compose up -d --build && docker compose --profile manual create ib-gateway` — both idempotent, so safe to re-run on every deploy. The `create` half is what populates `upside-ib-gateway-1` in stopped state so the api's dockerode `start` call has something to act on. Without it the first Connect tap returns 502 "no such container". Other commands: `down`, `ps`, `logs [service]`, `restart <service>`, `reset`. Root `package.json` also exposes parallel `docker:*` npm scripts for laptop convenience (`pnpm docker:up`, etc.) — both invoke the same underlying compose commands.

**Files this batch creates/edits:**
- `client/package.json` (add `packageManager` + `engines.node`)
- `docker-compose.yml` (swap `ib-gateway` image to IBeam; drop `cloudflared-ib`; mount secrets dir into IBeam ro)
- `.gitignore` (`secrets/`)
- `server/src/env.ts` (drop `CLOUDFLARED_IB_LOG_PATH`)
- `server/src/services/tunnelWatcher.ts` (single-watcher)
- `client/src/services/apiUrl.ts` (drop IB-portal helpers)
- `client/src/components/common/IBReconnectBlock.tsx` (slim "Connecting…" spinner)
- No `vercel.json`.

Kept as fallback (no change): `infra/clientportal.gw/Dockerfile` + `README.md` — used to build the bare gateway. Could be revived if IBeam ever stops being maintained.

**Output:** Live Upside app reachable from any browser at the Vercel URL. PWA installable on iOS / Android. IB session established automatically on container start, refreshed on IB's nightly forced logout.

**Verification:**
- Vercel URL loads on phone, shows Login screen.
- Google sign-in flow completes; brief "Connecting to IB…" screen appears.
- 2FA push arrives on IB Key phone app during IBeam's first login → approve → spinner dismisses → portfolio loads with real positions.
- Open simultaneously on phone and laptop; both render same data; an updated position appears on both within seconds.

**🎯 Milestone: Data-only live. Phone shows real portfolio.**

---

## Batch 13.1: Restore navigation + deeper /healthz

**Depends on:** Batch 13.

**Scope:** Re-wire the routing regression discovered after Batch 13. Components from Batches 2-3 (Ticker Detail screen, slide-in, chart, collapsible sections) still exist in `client/src/components/TickerDetail/*` but nothing routes to them. Tap on a PositionCard should open Ticker Detail. Bottom nav should reach Alerts and Settings (`ComingSoon` placeholders for now — real screens land in Batch 15).

**Also in scope (small, adjacent):** extend `/healthz` to return component statuses instead of `{ok:true}`. Lets us (and the Discord error notifier) diagnose without SSH.

### Deliverables

1. **Investigate and restore routing in `client/src/App.tsx` / `client/src/routes.tsx`**:
   - Route `/ticker/:symbol` mounts `<TickerDetail />`.
   - PositionCard tap handler navigates to `/ticker/${symbol}`.
   - Bottom nav routes: `/` → Portfolio, `/alerts` → Alerts (ComingSoon), `/settings` → Settings (ComingSoon).
   - Slide-in animation from Batch 2 should already work — verify CSS transform still in place.

2. **Verify TickerDetail renders against real data**, not stale mock data. May need a small data-fetch fix where Batches 9/11 changed the source of truth. The screen should pull from Supabase (positions table) for held positions; non-held positions render with all sections except PositionStats (per spec "held vs unheld" note).

3. **Extend `GET /healthz`** in `server/src/routes/`:
   - Return `{ ok, env, ib: 'connected' | 'stopped' | 'disconnected', supabase: 'reachable' | 'unreachable', redis: 'reachable' | 'unreachable', lastPricePoll: <timestamp | null> }`.
   - Each sub-check has its own 1s timeout; overall endpoint must respond within 3s even if a backend is down.
   - `ok` becomes `false` only if `supabase` or `redis` is unreachable (IB being stopped is normal, not unhealthy).

### Files this batch creates/edits
- `client/src/App.tsx`, `client/src/routes.tsx` (or wherever routes live), `client/src/components/PortfolioHome/PositionCard.tsx` (tap handler), `server/src/routes/health.ts` (or wherever `/healthz` lives).

### Does NOT touch
- Signal engine, polling, IB code, schema.

### Verification
- Phone: tap any position → Ticker Detail screen slides in from right with that ticker's data → back arrow returns to portfolio.
- Bottom nav reaches Alerts and Settings ComingSoon placeholders.
- `curl https://<vercel-url>/healthz` → returns full component status JSON.
- Stop the api container, hit `/healthz` from elsewhere → returns appropriate degraded status without timing out.

---

## Batch 13.2: Generic IB passthrough debug endpoint

**Depends on:** Batch 13 (live IB available via IBeam).

**Scope:** A single auth-gated, read-only, allowlist-enforced HTTP endpoint that proxies any IB Client Portal path the user supplies and returns the raw response untouched. Lets us pull live IB data shapes from the laptop with one `curl`, without spinning up the local Client Portal Gateway and re-authenticating in a browser. Strictly debug infrastructure; no FE surface.

**Why now (not post-MVP):** post-MVP Watchlist track will need to inspect the real shape of `/v1/api/iserver/watchlists` and friends to lock the schema. Having this tool available *during* MVP work means we can capture watchlist payloads any time without blocking on post-MVP starting. The endpoint is tiny (~50-100 lines), strictly debug-only, and doesn't expand MVP user-facing scope.

### Deliverables

1. **New route** `GET /api/debug/ib-passthrough?path=<IB-PATH>[&...querystring]` in `server/src/routes/debug.ts`:
   - **Auth-gated**: requires Bearer token from a whitelisted email. Non-whitelisted bearers → 403. Anonymous → 401.
   - **IB session required**: if IBeam container is not running or session not authenticated → 503 with `{ reason: 'ib_not_connected' }`.
   - **Path allowlist enforced**: the `path` query param must match one of an explicit allowlist of safe, read-only IB endpoints. Any other path → 400 with `{ reason: 'path_not_allowed', allowed: [...] }`.
   - **Method is GET only.** No body. No way to POST / PUT / DELETE through this endpoint.
   - **Response**: the raw IB response, content-type preserved, status code preserved (so 4xx/5xx from IB pass through transparently for debugging).

2. **Allowlist** (in `server/src/services/ibPassthroughAllowlist.ts`) — explicit list of regexes matching safe IB Client Portal paths. Initial set:
   ```
   ^/v1/api/iserver/accounts$
   ^/v1/api/iserver/account/[^/]+/summary$
   ^/v1/api/iserver/auth/status$
   ^/v1/api/iserver/contract/\d+/info$
   ^/v1/api/iserver/marketdata/history$
   ^/v1/api/iserver/marketdata/snapshot$
   ^/v1/api/iserver/secdef/search$
   ^/v1/api/iserver/watchlists$
   ^/v1/api/iserver/watchlist$
   ^/v1/api/portfolio/accounts$
   ^/v1/api/portfolio/[^/]+/ledger$
   ^/v1/api/portfolio/[^/]+/positions/\d+$
   ^/v1/api/portfolio/[^/]+/summary$
   ^/v1/api/portfolio/[^/]+/transactions$
   ^/v1/api/tickle$
   ```
   **Explicitly forbidden** (never add to allowlist, document why): anything under `/v1/api/iserver/account/[^/]+/orders`, `/v1/api/iserver/reply/`, `/v1/api/iserver/scanner/`, or any path containing `order` / `place` / `cancel` / `modify`. Order operations would let a compromised auth token execute trades. Even though the IB allowlist is positive (only listed paths pass), document this rule in `ibPassthroughAllowlist.ts` so future additions don't accidentally cross the line.

3. **Logging**: every passthrough call logs `{ caller_email, path, status, duration_ms }` to `external_api_metrics` with `provider: 'ib'` and a marker tag (e.g. `endpoint: 'debug-passthrough:<path>'`). Treats this surface as auditable from day one.

4. **Local capture workflow**: user runs from laptop:
   ```bash
   TOKEN=$(... fetch from Supabase session, or paste from browser dev tools)
   API_URL=https://<current-vercel-or-tunnel-url>

   curl -sS -H "Authorization: Bearer $TOKEN" \
     "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlists" \
     > captures/watchlists-$(date -u +%Y-%m-%d).json

   curl -sS -H "Authorization: Bearer $TOKEN" \
     "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlist&id=<wl_id>" \
     > captures/watchlist-<id>-$(date -u +%Y-%m-%d).json
   ```
   Files land in the gitignored `captures/` directory (already established in Batch 7).

5. **README note** in `server/README.md` or a new `docs/debug.md` documenting the endpoint, the allowlist policy, the curl workflow, and the security model.

### Files this batch creates/edits
- `server/src/routes/debug.ts` (new)
- `server/src/services/ibPassthroughAllowlist.ts` (new)
- `server/src/index.ts` (mount the debug route)
- `server/src/services/ibGateway.ts` (potentially add a generic `ibRawGet(path, query)` helper if one isn't already exposed)
- `docs/debug.md` (new, brief)

### Does NOT touch
- Any FE files.
- Any production routes or business logic.
- Schema.
- Discord.

### Manual prerequisites
- None new — uses existing whitelisted-email auth and the already-running IBeam.

### Verification
- Whitelisted email + connected IB + allowlisted path → JSON response from IB.
- Whitelisted email + connected IB + non-allowlisted path (e.g. `/v1/api/iserver/account/<id>/orders`) → 400 `path_not_allowed`.
- Non-whitelisted bearer → 403.
- No bearer → 401.
- IB disconnected → 503 `ib_not_connected`.
- Method other than GET → 405.
- After a few captures, `external_api_metrics` shows audit rows tagged `debug-passthrough:*`.

### Acceptance use-case (proof of utility, runs during this batch as the verification capstone)
- Capture `/v1/api/iserver/watchlists` and one specific `/v1/api/iserver/watchlist?id=<id>` from live IB.
- Paste the file list back into the chat with Claude so the post-MVP Watchlist track's data model can be locked against real shapes ahead of when its batch is built.

---

## Batch 13.5: Verify & implement `tradingDaysHeld` + MTD return

**Depends on:** Batch 13.1.

**Scope:** Two metrics flagged "⚠ Verification pending" in the spec — both currently unverified live. Resolve both, implement whichever is missing. After this batch, the spec's verification markers can be removed.

### Deliverables

1. **`tradingDaysHeld`** — for each held position, count of US trading days since entry:
   - First investigation: query IB's transactions endpoint (`/v1/api/portfolio/<acctId>/transactions` — confirm exact name) for transaction history per held conid. Confirm response shape gives reliable entry dates including for positions held >1 year.
   - If reliable: implement in `server/src/services/ibGateway.ts:ibTradingDaysHeld(conid)`, called by `pricePoller` once per position per session (cache result, only re-fetch if shares changed).
   - If unreliable for older positions: fall back to Upside-tracked entry-date (write `first_seen_at` on `positions` when a new conid first appears, use that). Older positions show "≥N days" until the user's next change-in-shares event.

2. **MTD return** — month-to-date portfolio return percent:
   - First investigation: query IB's account summary (`/v1/api/portfolio/<acctId>/summary` or `/v1/api/iserver/account/<acctId>/summary` — confirm) for an MTD field.
   - If present: surface via `GET /api/portfolio/summary` to the FE.
   - If absent: implement via Redis-cached `portfolio_value_month_start` (set on first poll of each new month, never overwritten until the next month begins). MTD = `(current - cached) / cached`. Persists across api restarts via Redis durability.

3. **FE wire-up**:
   - `tradingDaysHeld` → `PositionStats` section's "Days held" row and `daysHeld`-derived "Return per day" row.
   - MTD return → `SummaryStrip` right card.
   - Both should render with reasonable fallback states (e.g. "—" if data unavailable rather than crashing).

### Files this batch creates/edits
- `server/src/services/ibGateway.ts`, `server/src/services/redis.ts` (month-start cache helper if needed), `server/src/routes/portfolio.ts`, `server/src/cron/pricePoller.ts` (capture month-start), possibly `supabase/migrations/00X_position_first_seen.sql` (if IB transactions unreliable), `client/src/components/TickerDetail/PositionStats.tsx`, `client/src/components/PortfolioHome/SummaryStrip.tsx`.

### Does NOT touch
- Signal engine, Discord, zone detection.

### Verification
- Portfolio screen shows real MTD return value (not "—" or placeholder).
- Open any held position's detail → PositionStats shows real days-held + computed %/day.
- Document the verification findings in the commit message / claim notes so the spec's "⚠ Verification pending" markers can be removed.

---

## Batch 13.7: Finnhub rate-limited request queue

**Depends on:** Batch 13.

**Scope:** Build the queue infrastructure that all future Finnhub callers will use. No actual Finnhub features added in this batch — just the plumbing. Per-category cadence tuning happens in Batch 13.9 once real callers exist.

### Deliverables

1. **`server/src/services/finnhubQueue.ts`**:
   - Token-bucket limiter, 50 calls/min global (configurable via env `FINNHUB_RATE_LIMIT_PER_MIN`, default 50). 10-call buffer below Finnhub's 60/min free-tier ceiling.
   - Per-category min-interval-per-key support. Categories: `quote`, `candle`, `news`, `insider`, `earnings`, `profile` (extensible). Config map; default all categories to 0s min-interval (no throttle) for this batch — tuning happens in 13.9.
   - **No stale-cache returns** — requests for the same `(category, key)` within an in-flight or recent same-pair request **wait for the next eligible slot**, then get fresh data. Worst-case wait equals the category's min-interval.
   - FIFO ordering within a category; global token bucket shared across categories.
   - Exponential backoff + 1 retry on 429 (defensive only).
   - Exposed API: `finnhubQueue.request<T>(category, key, fn: () => Promise<T>): Promise<T>`.

2. **`server/src/services/finnhub.ts`** — existing stub gets a small refactor: every existing or skeleton Finnhub call goes through `finnhubQueue.request()`. Even if some functions are stubs, the queue wrapper is in place so 14a/14b can use them directly.

3. **Metrics table — rename or extend `ib_api_metrics` → `external_api_metrics`** (add a `provider text not null` column, default `'ib'` for existing rows). Instrument each Finnhub call same as IB: endpoint/category, duration_ms, status, retries. Lightweight; foundation for future per-category cadence tuning.

### Files this batch creates/edits
- `server/src/services/finnhubQueue.ts` (new), `server/src/services/finnhub.ts` (refactor to route through queue), `server/src/env.ts` (add `FINNHUB_RATE_LIMIT_PER_MIN`), `supabase/migrations/00X_external_api_metrics.sql` (rename or extend the IB metrics table).

### Does NOT touch
- Any feature consumer of Finnhub (those come in 14a/b/d).

### Verification
- Unit-test or manual: fire 100 requests in a tight loop through the queue, confirm fan-out respects 50/min and no Finnhub 429s.
- `external_api_metrics` shows rows for any test calls made.

---

## Batch 13.8: Multi-source price polling (IB primary, Finnhub fallback)

**Depends on:** Batch 13.7.

**Scope:** Make `current_price` updates IB-independent. When IB is connected, use IB. When IB is off, fall back to Finnhub quote endpoint via the queue. Both sources write to the same `positions` row. This is what makes the on-demand IBeam model actually viable as a daily-use product — the user can leave IB off and still see fresh-enough data.

### Deliverables

1. **Schema (`supabase/migrations/00X_price_source.sql`)**:
   - Add `price_source text not null default 'ib'` to `positions` (enum-like: `'ib' | 'finnhub'`).
   - Add `last_price_update_at timestamptz null` to `positions` (used by Finnhub poller to decide whether to skip).

2. **`server/src/cron/pricePoller.ts`** — split / rename:
   - `ibPricePoller`: keeps existing adaptive cadence (10s / 60s / 5min based on market period). Writes with `price_source: 'ib'` and updates `last_price_update_at`. Runs only when IB session `connected`.
   - `finnhubPricePoller`: new. 60s cadence, always-on. For each held position, if `last_price_update_at` is null or older than 90s, fetch quote via `finnhubQueue.request('quote', symbol, ...)` and write with `price_source: 'finnhub'`.

3. **Optional FE indicator (cheap to add now, deferred render):** PositionCard accepts `priceSource` prop. Default: render nothing extra. Behind a feature flag, render a small "F" badge near the price when source is Finnhub. Useful for debugging but no need to expose to user yet.

### Files this batch creates/edits
- `server/src/cron/ibPricePoller.ts` (renamed from / split off pricePoller.ts), `server/src/cron/finnhubPricePoller.ts` (new), `server/src/services/finnhub.ts` (add `getQuote(symbol)`), `supabase/migrations/00X_price_source.sql`, optional small PositionCard prop addition.

### Does NOT touch
- Signal engine, zone detection (those come in 14a/14c respectively but consume what this batch provides).

### Verification
- IB connected: positions update every 10-60s with `price_source = 'ib'`.
- Disconnect IB via FE button → wait 90s → Supabase shows positions still updating, `price_source = 'finnhub'`.
- Reconnect IB → next IB poll wins → `price_source` returns to `'ib'`, Finnhub poller goes idle.

---

## Batch 14a: Signal engine + manual SELL analysis end-to-end

**Depends on:** Batch 13.1, 13.5, 13.7.

**Scope:** The brain. User taps Analyze → 10-15s later a real signal lands in Supabase and renders on the ticker detail screen. Replaces the original Batch 14 in the queue; split into 14a (engine) and 14b (accuracy) for cleaner scope.

### Deliverables

#### Backend

1. **Provider implementations in `server/src/services/llm.ts`**:
   - Real `GeminiProvider.analyze(context)` using Gemini API.
   - Stubs for `ClaudeProvider` / `OpenAiProvider` that throw a clear error pointing to the relevant env var.

2. **`server/src/services/signalEngine.ts`** (new) — orchestrates a single analysis:
   - Acquire `analysis_locks` row (lock cleanup TTL is 5 min — see step 7).
   - Ensure `contracts` cache row exists (lazy-fetch).
   - Pull intraday + daily history from IB; compute RSI, MACD, Bollinger, VWAP via `technicals.ts`.
   - Pull current snapshot via `ibGateway.ibSnapshot`.
   - Pull news / earnings / insider data via Finnhub (through the queue).
   - **Read position's zone state** (`zone_entered_at`, `entered_zone_via_gap`). If `inZone`: populate `contextualTriggers.inProfitTakingZone = { thresholdPct, currentPnlPct, viaGap }`. Otherwise null.
   - Assemble structured LLM prompt. **Reserve `contextualTriggers` section in prompt structure** — even though only `inProfitTakingZone` is populated in 14a (which gets meaningful values once 14c lands), the framework is in place for future trigger types.
   - Call `llm.analyze()`.
   - **Zod-validate the LLM response.** On malformed: retry once with a stricter prompt. On second failure: write a `no_signal` record with reason "LLM response malformed" and release lock.
   - Insert validated signal into `signals` table.
   - Release lock.

3. **`server/src/services/technicals.ts`** — full implementations: `rsi()`, `macd()`, `bollinger()`, `vwap()`. Use `technicalindicators` npm package.

4. **`server/src/services/finnhub.ts`** — flesh out `getCompanyNews`, `getInsiderTransactions`, `getEarningsCalendar` (all through the queue).

5. **`server/src/routes/signals.ts`** — replace the 501 stub with a real handler:
   - **Re-analyze soft-block**: check if a `signals` row exists for `(user_id, symbol)` with `analyzed_at` within last 5 min. If yes: return `429` with `{ lastAnalyzedAt, reason: 'recent_analysis' }` so FE can prompt "Last analyzed 3 min ago — re-analyze anyway?". FE re-sends with `force: true` to bypass.
   - **Daily cost ceiling**: env var `MAX_LLM_CALLS_PER_DAY` (default 50). Per-day counter in Redis keyed `llm_calls:YYYY-MM-DD` with midnight-UTC TTL. If exceeded: return 429 with `{ reason: 'daily_limit_reached' }`.
   - Invoke `signalEngine.analyze()` async, return 202 immediately. FE subscribes to `signals` Realtime to detect completion.

6. **Note on idempotency**: explicitly **NOT** adding idempotency keys. The `analysis_locks` row already prevents concurrent double-runs (second tap sees lock, button disabled). Adding idempotency keys would only interfere with intentional re-analysis during testing.

7. **Analysis lock TTL bumped to 5 min**: cron `lockCleanup.ts` cleans rows older than 5 min. Worst-case Gemini response is ~30s but we leave margin for network blips, retries, and slow third-party calls.

#### Frontend

8. **`client/src/components/TickerDetail/SignalSection.tsx`** — wire to real signal data via Supabase Realtime. Latest non-superseded signal renders; "View history" expands the chronological list.
9. **`client/src/hooks/useAnalysisLock.ts`** — subscribe to `analysis_locks` for the active (user, symbol) → disable Analyze button when locked.
10. **Two-step Analyze button (per spec)**: tap → grey out 1s → "Confirm analyze" → tap again → POST `/api/signals/analyze`.
11. **Re-analyze soft-block UI**: on 429 with `reason: 'recent_analysis'` + `lastAnalyzedAt`, render confirm prompt: "Last analyzed {N} min ago — re-analyze anyway?" with Yes/Cancel. On Yes, re-POST with `force: true`.
12. **Daily-limit-reached UI**: on 429 with `reason: 'daily_limit_reached'`, show inline "Daily analysis limit reached — resets at midnight UTC" and disable button until then.

### Files this batch creates/edits
- `server/src/services/llm.ts`, `server/src/services/signalEngine.ts` (new), `server/src/services/technicals.ts`, `server/src/services/finnhub.ts`, `server/src/services/redis.ts` (LLM cost counter helpers), `server/src/routes/signals.ts`, `server/src/cron/lockCleanup.ts` (renamed from signalRunner.ts, 5-min TTL), `client/src/components/TickerDetail/SignalSection.tsx`, `client/src/hooks/useAnalysisLock.ts`, `client/src/hooks/useSignals.ts`.

### Manual prerequisites (user)
- Get Gemini API key at aistudio.google.com → add `GEMINI_API_KEY` to VPS `.env`.
- Get Finnhub API key at finnhub.io → add `FINNHUB_API_KEY` to VPS `.env`.
- `docker compose restart api`.

### Verification
- Tap Analyze on a held position → 1s greyed → tap again → ~10-15s later signal renders with quality score, price range, optimal price, reasoning, indicator bullets.
- Tap Analyze again immediately → 429 with soft-block prompt → confirm → new analysis runs.
- Force 51 analyses in a day (test mode) → 51st returns daily-limit-reached.
- Crash mid-analysis via SIGKILL on the api → cron cleans up stale lock within 5 min → button re-enables.
- Send a malformed LLM response (test mode) → retry happens → second failure writes `no_signal` with reason "LLM response malformed" → no crash.

---

## Batch 14b: Daily hindsight accuracy tracking cron

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

## Batch 14c: Profit-taking zone detection + Discord notifications + card UI

**Depends on:** Batch 13.8.

**Scope:** Continuous detection that a position is in profit-taking zone (P&L crosses threshold). One Discord notification per zone-entry with 4h cooldown. Card UI emphasis with tooltip. LLM `contextualTriggers` field populated. Replaces the originally-planned pre-market gap detection — gap is now just one cause of zone-entry, marked with a small "GAP" badge for the day.

### Deliverables

#### Backend

1. **Schema (`supabase/migrations/00X_profit_zone.sql`)**:
   - Add to `positions`: `zone_entered_at timestamptz null`, `zone_exited_at timestamptz null`, `last_zone_notification_at timestamptz null`, `entered_zone_via_gap boolean not null default false`.
   - Add to `user_preferences`: `profit_zone_threshold_pct numeric not null default 2.0`.

2. **Zone state recomputation** — extend `ibPricePoller` and `finnhubPricePoller` (from Batch 13.8) to compute zone state on every write:
   - Read user's threshold from `user_preferences`.
   - `wasInZone = (priorRow.zone_entered_at !== null)`; `nowInZone = pnlPct >= threshold`.
   - If `!wasInZone && nowInZone`: set `zone_entered_at = now()`, `entered_zone_via_gap = (now() < todays_regular_open_in_ET)`, call `discord.notifyZoneEntry()` (which checks cooldown internally).
   - If `wasInZone && !nowInZone`: set `zone_exited_at = now()`, clear `zone_entered_at`.
   - At end-of-regular-session each day: clear `entered_zone_via_gap` for all positions (small daily cleanup task).

3. **`server/src/services/discord.ts`** — extend existing multi-channel notifier:
   - New env var: `DISCORD_WEBHOOK_ZONES`.
   - `notifyZoneEntry(position)` function. Internal cooldown check: if `last_zone_notification_at` is within 4h, skip silently. Else fire notification and set `last_zone_notification_at = now()`.
   - Message format: `🔔 {symbol} entered profit-taking zone — P&L +{X.XX}% (threshold: +{Y}%){gap suffix if viaGap}`.

4. **`contextualTriggers` populated in `signalEngine`** (cooperates with Batch 14a):
   - When user taps Analyze, signalEngine reads position's `zone_entered_at` and `entered_zone_via_gap`.
   - If `inZone`: populate `contextualTriggers.inProfitTakingZone = { thresholdPct, currentPnlPct, viaGap }`.
   - The LLM prompt's contextual-triggers section interpolates: "This position is in profit-taking zone (P&L +X.X%, threshold +Y%). Address specifically: should we take profit here, or hold for more? {If viaGap: 'Zone entry was caused by an overnight gap, which often fades at open due to others taking profit.'}"
   - This batch updates the prompt template; the framework hookup itself happened in 14a.

#### Frontend

5. **`client/src/components/PortfolioHome/PositionCard.tsx`**:
   - When `position.zone_entered_at IS NOT NULL` (and not exited): render small icon (initial pick: `⇡` Unicode glyph or a lightning-bolt SVG — final choice during implementation) next to the P&L number on the card.
   - **Tooltip**: hover (desktop) or long-press (mobile) shows: `"Profit-taking zone — P&L crossed +{threshold}% threshold. Consider analyzing."`. Use a small `Tooltip` common component (Radix UI tooltip is fine; or hand-rolled with proper a11y attributes).
   - When `entered_zone_via_gap`: additionally render a small "GAP" mini-badge near the icon for the trading day.
   - Card structural layout is NOT altered. Icon and GAP badge are inline with P&L.

6. **`client/src/components/TickerDetail/SignalSection.tsx`** — when position `inZone`, show inline shortcut button "Analyze for profit-taking?" that triggers the normal Analyze flow (the `contextualTriggers` get auto-attached server-side based on current zone state).

7. **Common `Tooltip` component** (`client/src/components/common/Tooltip.tsx`) — if it doesn't already exist. Hover for desktop, long-press for mobile. ESC dismisses. Used by the zone icon and gap badge here; potentially other future hover-help surfaces.

### Files this batch creates/edits
- `supabase/migrations/00X_profit_zone.sql`, `server/src/cron/ibPricePoller.ts` + `finnhubPricePoller.ts` (zone recompute), `server/src/services/discord.ts` (zones channel + notifyZoneEntry), `server/src/services/signalEngine.ts` (contextualTriggers populator), `client/src/components/PortfolioHome/PositionCard.tsx`, `client/src/components/TickerDetail/SignalSection.tsx`, `client/src/components/common/Tooltip.tsx`, `client/src/types/index.ts` (Position type additions: `zone_entered_at`, `entered_zone_via_gap`, etc.).

### Manual prerequisite (user)
- Create new Discord channel `#upside-zones`, generate webhook, add `DISCORD_WEBHOOK_ZONES` to VPS `.env`, `docker compose restart api`.

### Verification
- Set threshold to 0.5% temporarily; positions cross threshold → Discord ping arrives in `#upside-zones`, card icon appears.
- Tooltip on hover (desktop) and long-press (mobile) shows correct text.
- Price flips in/out of zone within 4h → only first transition notifies.
- Manually update a position to simulate overnight gap (write a zone-entry timestamp before today's open) → GAP badge renders alongside zone icon → clears at end of session.
- Tap Analyze on a zone position → signal reasoning explicitly addresses profit-taking decision.

---

## Batch 14d: Signal-range Discord notifications

**Depends on:** Batch 14a, 14c.

**Scope:** Notify when live price enters an open signal's predicted range. Same Discord infrastructure as 14c, different trigger and channel.

### Deliverables

1. **`server/src/services/discord.ts`** — `notifySignalRangeEntry(signal, position)`. New env var: `DISCORD_WEBHOOK_SIGNALS_SELL`.
   - Message format: `🎯 {symbol} entered SELL signal range — price ${price} ∈ [${low}, ${high}], optimal ${optimal}. Signal generated {when}.`

2. **Trigger logic** — extend the same price pollers from 13.8:
   - For each price write, check all open signals (`superseded_by_analysis_id IS NULL` AND not expired) for this position.
   - If `current_price` is within `[price_range_low, price_range_high]` and `entered_range_at IS NULL`: fire notification, set `entered_range_at`.
   - Cooldown not needed — signal-entry is a one-time event per signal (subsequent re-entries are recorded via accuracy tracking, not re-notified).

3. **Future channels reserved**: `DISCORD_WEBHOOK_SIGNALS_BUY` (post-MVP for BUY signals), `DISCORD_WEBHOOK_EVENTS` (post-MVP for info badges like earnings/insider/volume). Document in `.env.example`.

### Files this batch creates/edits
- `server/src/services/discord.ts`, `server/src/cron/ibPricePoller.ts` + `finnhubPricePoller.ts` (range-check hook), `.env.example`.

### Manual prerequisite (user)
- Create `#upside-signals-sell` Discord channel + webhook → `DISCORD_WEBHOOK_SIGNALS_SELL` to `.env` → `docker compose restart api`.

### Verification
- Generate a sell signal with a range slightly above current price. Wait for price to drift up into range (or simulate via manual Supabase update). Discord ping arrives once in `#upside-signals-sell`; `entered_range_at` set on the signal row.
- Re-trigger same condition → no duplicate notification (one-time event).

---

## Batch 14.5: Schema cleanup — remove `position_history`

**Depends on:** Batch 13.

**Scope:** Drop the unused `position_history` table and related references. MTD now comes from Redis cached month-start (Batch 13.5); accuracy lives on `signals`. The table was deferred-feature scaffolding that never had a real use case.

### Deliverables
1. **`supabase/migrations/00X_drop_position_history.sql`**: `drop table if exists position_history cascade;`.
2. Edit `supabase/migrations/001_initial.sql` (the consolidated baseline) to remove the `position_history` table definition so a future fresh apply doesn't recreate it.
3. Grep codebase for any imports / types referring to it → remove.
4. Spec entry for `position_history` already removed (handled in spec edits).

### Files this batch creates/edits
- `supabase/migrations/00X_drop_position_history.sql`, `supabase/migrations/001_initial.sql`, possibly `server/src/types/index.ts`.

### Does NOT touch
- Active features.

### Verification
- `select * from position_history` errors with "relation does not exist".
- `pnpm typecheck` clean (or equivalent).

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

## Batch 15: Alerts feed (Screen 3) + Settings (Screen 4) wired

**Depends on:** Batch 14a, 14b, 14c.

**Scope:** Replace the two `ComingSoon` placeholders with real screens. Now also includes profit-zone threshold control and aggregate accuracy display.

### Deliverables

1. **Alerts feed (`/alerts`)** — chronological list of generated signals AND zone-entry events, newest first.
   - **Display filter slider**: "Show signals above ___% Quality" (range: 0-100, default 50). **Display filter only — does NOT affect generation.** Settings has the separate generation threshold.
   - Filter pills: All / Sell / Zone-Entry / no_signal.
   - Empty state: "No signals yet. Tap Analyze on any position to generate one."

2. **"I acted on this" button** on each Alerts list item → POST sets `signals.acted_on_at`. Discord-published zone-entries get a similar lightweight "Mark as seen" affordance (post-MVP if scope tightens).

3. **Aggregate accuracy display** at top of Alerts feed: pulls from `GET /api/signals/accuracy` from Batch 14b. Shows: "Recent SELL signals: X% hit-rate over 30d, median +Y% from optimal." Placeholder copy if data is sparse in early days.

4. **Settings (`/settings`)** — app-level (per spec):
   - **IB Connection**: status indicator + Connect/Disconnect button (uses existing on-demand IBeam flow from Batch 13).
   - **Signal generation threshold** (signal-quality minimum to bother generating; persists to `user_preferences.signal_threshold`). Clarify in copy: "BE-level minimum; the Alerts feed has a separate display filter."
   - **Signal min market value** ($, persists to `user_preferences.signal_min_market_value`).
   - **Suppressed symbols** (text list, persists to `user_preferences.suppressed_symbols`).
   - **Profit-taking zone threshold** (slider 0.5%-10%, default 2%, persists to `user_preferences.profit_zone_threshold_pct`).
   - **Theme** (Dark / Light / System, persists).
   - **LLM provider** dropdown (Gemini / Claude / OpenAI, persists; takes effect on next analyze).
   - **Sign out** button.

5. **`PUT /api/user/preferences`** — BE endpoint validates + upserts the user_preferences row. FE writes through this rather than directly to Supabase to keep validation centralized.

### Files this batch creates/edits
- `client/src/pages/Alerts.tsx`, `client/src/pages/Settings.tsx`, `client/src/components/AlertsFeed/*`, `client/src/components/Settings/*`, `client/src/hooks/useUserPreferences.ts`, `client/src/routes.tsx`, `server/src/routes/user.ts` (new — preferences PUT/GET).

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
