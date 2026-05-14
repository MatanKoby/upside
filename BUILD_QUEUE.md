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
   - `ib-gateway`: image `ghcr.io/gnzsnz/ib-gateway:stable` — confirmed ARM64/aarch64 multi-arch support, Docker auto-selects correct variant. Port 5000 internal only. **DO NOT set `TWS_USERID` / `TWS_PASSWORD` env vars** — IB credentials NEVER live in server config per security model. We use the image purely as a Java gateway runner; auth happens via REST API calls from Node backend that proxies user-entered credentials from browser. Set `TRADING_MODE=live`. Restart unless-stopped.
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

## Batch 6: Real-time price loop + frontend wiring

**Depends on:** Batch 1 + Batch 5

**Scope:** Implement real-time polling, connect frontend to live Supabase data instead of mock data.

**Deliverables:**

### Backend:
1. `cron/pricePoller.ts` — full implementation: poll IB every 5-15s during market hours, cache Redis, write Supabase only on change, handle rate limits + session expiry
2. `cron/keepalive.ts` — IB tickle every 30s, Supabase ping every 4h
3. `utils/marketHours.ts` — detect pre-market/regular/after-hours/closed based on ET, weekends, US market holidays

### Frontend:
4. `services/supabase.ts` — client initialization
5. `hooks/usePositions.ts` — replace mock data with REST fetch + Supabase Realtime subscription. When Supabase notifies positions changed → pull fresh data from Supabase (source of truth)
6. `hooks/useSignals.ts` — Supabase Realtime on signals table → pull updated signal on change
7. `hooks/useMarketSession.ts` — polls `/api/auth/status` every 30s, returns `{ session: 'connected' | 'expired' | 'disconnected', marketPeriod: 'pre-market' | 'regular' | 'after-hours' | 'closed' }`
8. Update PositionCard, SummaryStrip, Sparkline to accept real data props
9. Sparkline fetches 7-day bars from `/api/marketdata/history/:symbol`

### Connection status in header (always visible):
- A small status dot in the header (next to the market period badge) shows IB connection state at all times
- `connected` → green dot, no text
- `disconnected` → amber dot + "Reconnecting..." text, retrying silently in background
- `expired` → red dot + "Session expired" text
- On reconnect success → dot returns to green automatically

### Session expired — full UI block:
- When app opens and IB session is expired, the entire UI is replaced with a full-screen reconnect prompt (not a banner)
- Shows: Upside logo, "Your IB session has expired" message, "Reconnect" button
- On tap: proxies credentials to IB gateway → waits for 2FA approval on IB Key app → animated "Waiting for approval..." state → on success, dismisses block and loads portfolio
- Cached data is NOT shown beneath the block — session must be restored before portfolio is visible

### Mid-session IB failure (hiccup):
- Real-time loop retries silently up to 3 times with exponential backoff
- Header dot changes to amber "Reconnecting..." immediately on first failure
- If restored within retries → dot returns to green, no disruption to UI
- If all retries fail → dot turns red "Session expired" → user taps dot to trigger reconnect flow (same flow as above but as a non-blocking side sheet, not full-screen block, since user already has data loaded)

**TypeScript interfaces (`server/src/types/index.ts` and `client/src/types/index.ts`):**
```typescript
interface Position {
  symbol: string
  companyName: string
  shares: number
  avgCost: number
  currentPrice: number
  marketValue: number
  unrealizedPnl: number
  unrealizedPnlPct: number
  todayChange: number
  todayChangePct: number
  vwap: number | null
  vwapDiffPct: number | null
  portfolioWeight: number      // positionValue / totalPortfolioValue
  portfolioContribution: number // unrealizedPnlPct * portfolioWeight
  dailyReturn: number | null   // unrealizedPnlPct / tradingDaysHeld
  tradingDaysHeld: number | null
  updatedAt: string
}

interface Signal {
  id: string
  symbol: string
  signalType: 'sell' | 'buy' | 'watch' | 'event'
  confidence: number           // 0-100
  reasoning: string
  targetPriceLow: number | null
  targetPriceHigh: number | null
  timeframe: string | null
  riskReward: string | null
  indicators: IndicatorSnapshot[]
  createdAt: string
  expiresAt: string | null
}

interface IndicatorSnapshot {
  name: string
  value: string
  status: 'bullish' | 'bearish' | 'neutral'
}

type MarketPeriod = 'pre-market' | 'regular' | 'after-hours' | 'closed'
type SessionStatus = 'connected' | 'disconnected' | 'expired'
```

**Files:** `server/src/cron/*`, `server/src/utils/marketHours.ts`, `client/src/services/supabase.ts`, `client/src/hooks/*`, updates to PortfolioHome components, `client/src/types/index.ts`, `server/src/types/index.ts`


