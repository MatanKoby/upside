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
- **Market Data**: IB API (primary — positions, prices, VWAP), Finnhub (news, sentiment, fundamentals — free 60 calls/min), Alpha Vantage (technical indicators — free 25 calls/day)
- **AI/LLM**: Anthropic Claude API (Sonnet for reasoning, Haiku for classification) — ~$5-10/mo
- **Caching**: Upstash Redis (free tier — 10K commands/day)
- **Hosting**: Vercel (frontend, free), Oracle Cloud (backend + IB gateway, free)
- **CI/CD**: GitHub + GitHub Actions (free)

### Infrastructure Notes
- Oracle Cloud Always Free: 4 ARM OCPUs, 24 GB RAM, 200 GB storage — runs backend + IB gateway + Redis
- IB Gateway requires manual browser login ~every 24h (user opens IB/TWS daily anyway)
- No Playwright/automated login — IB prohibits it for individual accounts, risk of account flagging
- Cloudflare Tunnel (free) to expose IB gateway if needed
- All prices are live during trading sessions (pre-market 4:00 AM - after-hours 8:00 PM ET), showing last close only on weekends

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

Opens when tapping a position card (not the signal row). Full-screen view for one position.

#### Header
- Back arrow (ti-arrow-left) + ticker symbol + company name
- Current price + today's change (colored)

#### Price Chart
- Interactive candlestick or line chart (use Lightweight Charts by TradingView — free, open source)
- Timeframe selector: 1D, 1W, 1M, 3M, 1Y
- User's entry price(s) marked as horizontal dashed lines on chart
- VWAP line overlaid on chart during intraday views

#### Position Stats
- Shares held
- Average cost basis
- Current value
- Unrealized P&L ($ and %)
- Today's change ($ and %)
- %/day return: total % gain divided by trading days held (e.g. "+0.79%/day")
- Portfolio contribution: weighted return showing impact on total portfolio (e.g. "Contributing +5.0% to portfolio" for a position that's +10% and is 50% of portfolio)
- Portfolio weight: "44% of portfolio"

#### Active Signals Section
- If any signals exist for this ticker, show the full Style A analytical breakdown inline
- If no signals, show "No active signals" with muted text

#### Signal Detail (Style A — Analytical Breakdown)
This is the expanded view of a signal. Shows either inline on ticker detail or as a modal when tapping a signal pill on the home screen.

Layout:
- Signal type badge + confidence bar (0-100%, colored fill)
- Timeframe: "3-7 days" / "Intraday" / "1-2 weeks"
- Target price range: "$186-189"
- Risk/reward ratio: "1:2.4"

Indicator breakdown (table of rows):
- Each row: Indicator name | Current value | Status badge (Bullish/Bearish/Neutral)
- Indicators: RSI (14), VWAP divergence, MACD, Volume trend, Bollinger Band position, Support/Resistance levels, and any others relevant
- Status badges: green for bullish, red for bearish, gray for neutral

Summary counts: "5 of 6 indicators bearish"

AI reasoning text: 2-3 sentence natural language explanation of why this signal was generated, citing the specific data points.

"Ask about this signal" button → opens AI chat (post-MVP: just save as a feature hook)

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

### IB API → Backend
1. Backend runs IB Client Portal Gateway (Java) on Oracle VPS
2. Node.js proxy layer wraps gateway REST endpoints
3. Key endpoints used:
   - `GET /portfolio/{accountId}/positions` — current positions
   - `GET /portfolio/{accountId}/summary` — account summary (total value, P&L)
   - `GET /iserver/marketdata/snapshot` — live quotes (price, VWAP, volume)
   - `GET /iserver/marketdata/history` — historical bars for sparklines/charts
   - `GET /portfolio/{accountId}/ledger` — P&L breakdown

### Backend → Frontend
- REST API for initial data load
- WebSocket (or SSE) for real-time price updates during market hours
- Polling fallback (every 5-15s) when WebSocket isn't available

### Backend → Supabase
- Store position snapshots (daily) for historical tracking
- Store user preferences (sort order, confidence threshold, etc.)
- Store generated signals and their outcomes (for future accuracy tracking)

### Signal Engine (Sprint 3)
1. Collect: IB price data + Finnhub news/sentiment + computed technicals
2. Analyze: Calculate RSI, MACD, Bollinger, VWAP divergence, support/resistance
3. Synthesize: Feed indicator states + news context into Claude API
4. Output: Signal type, confidence score (0-100), reasoning text, timeframe, target price range
5. Store: Save signal in Supabase, push to frontend via WebSocket
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
├── client/                 # React frontend (Vite)
│   ├── src/
│   │   ├── components/
│   │   │   ├── PortfolioHome/
│   │   │   │   ├── PositionCard.tsx
│   │   │   │   ├── SummaryStrip.tsx
│   │   │   │   ├── SortBar.tsx
│   │   │   │   ├── MarketPeriodBadge.tsx
│   │   │   │   └── Sparkline.tsx
│   │   │   ├── TickerDetail/
│   │   │   ├── SignalDetail/
│   │   │   ├── AlertsFeed/
│   │   │   ├── Settings/
│   │   │   └── common/
│   │   ├── hooks/
│   │   │   ├── usePositions.ts
│   │   │   ├── useRealtimePrices.ts
│   │   │   └── useSignals.ts
│   │   ├── services/
│   │   │   ├── ibApi.ts
│   │   │   └── supabase.ts
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
├── server/                 # Node.js backend
│   ├── src/
│   │   ├── routes/
│   │   │   ├── portfolio.ts
│   │   │   ├── marketdata.ts
│   │   │   └── signals.ts
│   │   ├── services/
│   │   │   ├── ibGateway.ts     # IB API wrapper
│   │   │   ├── finnhub.ts
│   │   │   ├── alphaVantage.ts
│   │   │   └── signalEngine.ts  # Sprint 3
│   │   ├── middleware/
│   │   └── index.ts
│   └── package.json
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
