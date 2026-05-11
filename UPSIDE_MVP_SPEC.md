# Upside — MVP Product Specification

## Overview

Upside is a mobile-first PWA portfolio intelligence layer for Interactive Brokers. It displays your IB portfolio positions with real-time data, AI-powered signals (sell windows, entry points, event alerts), and contextual insights. Built for a solo intraday/swing trader on NYSE/NASDAQ, phone-first usage, 24/7 availability.

---

## Architecture

### Tech Stack
- **Frontend**: React (Vite) + TypeScript, PWA-enabled
- **Backend**: Node.js + Express (or Fastify), running on Oracle Cloud Always Free VPS
- **Database**: Supabase (PostgreSQL + Auth + Realtime) — free tier (500 MB DB, 50K MAUs)
- **Broker API**: IB Client Portal API (REST), gateway runs on same Oracle VPS
- **Market Data**: IB API (all prices, OHLCV bars, VWAP, fundamentals), Finnhub (news, sentiment, insider trades, earnings — free 60 calls/min)
- **Technical Indicators**: Computed locally from IB price data using `technicalindicators` npm library (RSI, MACD, Bollinger, SMA/EMA, Stochastic, support/resistance, volume profile)
- **AI/LLM**: Gemini free tier via Google AI Studio (initially). Provider-agnostic abstraction layer — swap to Claude/OpenAI via env var. No vendor lock-in.
- **Caching**: Redis (self-hosted in Docker container on Oracle VPS — no external service)
- **Hosting**: Vercel (frontend, free *.vercel.app subdomain), Oracle Cloud (backend + IB gateway + Redis, free)
- **CI/CD**: GitHub (private repo) + manual deploy initially, GitHub Actions later
- **Total monthly cost**: $0 (Gemini free tier). Upgrade path: ~$5-10/mo if switching to Claude API.

### Infrastructure — Oracle Cloud VPS (US-Ashburn)
- Oracle Cloud Always Free: 4 ARM OCPUs, 24 GB RAM, 200 GB storage
- Docker Compose runs 3 containers:
  1. **IB Client Portal Gateway** (Java) — IB's software, exposes REST API on localhost:5000
  2. **Upside Node.js app** (Express + WebSocket + cron jobs + signal engine) — the brain
  3. **Redis** — local caching for IB rate-limit buffering and data deduplication
- All 3 containers communicate via Docker internal network (localhost)

### IB Authentication Flow
- Manual login via Upside UI: enter IB username/password → approve 2FA on IB Key phone app
- No automated login (IBeam/Playwright) — IB prohibits it for individual accounts, risk of account flagging
- Session maintained via tickle endpoint every 30s, lasts until IB's nightly forced logout (~11:45 PM ET)
- On session expiry: app shows cached data + amber "Reconnect" banner, one-tap re-auth
- Daily ritual: open app → tap reconnect → approve 2FA → live data (~10 seconds)
- User's IB Israel account (U-prefix) works with Client Portal API

### Data Sources (simplified)
- **IB API provides**: real-time prices, OHLCV bars (any interval/timeframe), VWAP, volume, historical data (20+ years), fundamentals (P/E, EPS, market cap, beta, 52-week range), position/account data
- **Computed locally from IB data**: RSI, MACD, Bollinger Bands, SMA/EMA, Stochastic, VWAP divergence, support/resistance, volume profile
- **Finnhub provides**: company news + sentiment scores, insider transactions, earnings calendar + estimates, basic financials (supplementary)
- **Alpha Vantage**: DROPPED — 25 calls/day too limiting, all technicals computed locally instead
- **Sparklines**: fetched live from IB (7 daily bars per ticker), current day updates in real-time. No overnight batch needed.

### IB API Rate Limits
- Global: 10 requests/second via Client Portal API
- Historical data: no hard limit for bars ≥1 min, but soft pacing — avoid >60 requests/10 min
- With <10 positions, rate limits are not a concern. Redis cache prevents redundant calls.

### Signal Engine Filters
- Skip positions with market value < $200 (configurable threshold)
- Skip positions where user has manually disabled signal generation
- Skip positions opened less than configurable hours ago (avoid noise on new entries)
- Filters checked before any API calls, saving LLM tokens and Finnhub quota

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

### Sprint 1 — Get data on screen (~1 week)
1. IB gateway + Node.js API proxy on Oracle VPS
2. Portfolio home screen with real IB position data (static initially)
3. Supabase setup + auth (single user)

### Sprint 2 — Make it live (~1 week)
4. Real-time price updates (WebSocket/polling from IB, all sessions)
5. Sparklines (7-day daily closes) + P&L tint intensity
6. VWAP data from IB market data
7. Sort views (P&L, custom drag)
8. Ticker detail screen

### Sprint 3 — Add intelligence (~2 weeks)
9. Signal analysis engine (technical indicators + LLM synthesis)
10. Signal pills on position cards
11. Signal detail view (Style A analytical breakdown)

### Sprint 4 — Notifications + polish (~1 week)
12. PWA push notifications
13. Alerts feed screen
14. Settings screen

### Post-MVP
- AI chat (conversational portfolio Q&A)
- Natural language ticker screener
- Trade journal with %/day metric

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
- Header also has icon buttons: chat (ti-message-chatbot), notifications (ti-bell), settings (ti-settings)

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

- **IB Connection**: Status indicator (connected/disconnected/session expired), last sync time, reconnect button
- **Signal Preferences**: Confidence threshold slider (same as alerts), enable/disable per signal type (sell/buy/event)
- **Notifications**: Toggle push notifications on/off, quiet hours setting, per-type toggles
- **Display**: Dark/light mode toggle (or system default), market period display preferences
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
│   │   │   ├── finnhub.ts       # News, sentiment, earnings
│   │   │   ├── signalEngine.ts  # Technical analysis + LLM synthesis
│   │   │   ├── technicals.ts    # RSI, MACD, Bollinger computation
│   │   │   ├── llm.ts           # Provider-agnostic LLM abstraction layer
│   │   │   ├── redis.ts         # Redis cache wrapper
│   │   │   └── supabase.ts      # Supabase client for server-side writes
│   │   ├── cron/
│   │   │   ├── pricePoller.ts   # Real-time loop (5-15s)
│   │   │   ├── signalRunner.ts  # Signal loop (15-30 min)
│   │   │   └── keepalive.ts     # Supabase + IB session keepalive
│   │   ├── middleware/
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml       # 3 containers: IB Gateway, Node.js, Redis
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