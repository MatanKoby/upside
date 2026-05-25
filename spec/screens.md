# Screens & UI

All screen specifications, the design system, the FE primitives catalog, and key UI metrics. Includes post-MVP screens (Watchlists) as forward-spec so Track 1 has a build-ready target.

## TickerCard (shared component)

A single component used across Portfolio screen, Watchlists (post-MVP), and anywhere else a ticker is rendered as a card row. Variant prop discriminates rendering:

```ts
type TickerCardVariant =
  | { kind: 'held'; position: Position; signals: Signal[] }
  | { kind: 'watchlist'; ticker: WatchlistTicker; signals: Signal[] };
```

Single component, internal branching on three conditionals (P&L tint vs. none, weight bar vs. none, center area as P&L vs. BUY range vs. empty). The card is mostly composition; the rendering is done by shared primitives (see "Primitives catalog" below).

**Held variant** renders: ticker, company, P&L combined (center), sparkline, current price, today's change, VWAP indicator, portfolio weight bar (bottom), signal pill row. P&L tint background scales with magnitude. Optional zone icon + GAP badge before P&L number when `inZone` (see `signal-model.md` → Profit-Taking Zone Detection).

**Watchlist variant** renders: ticker, company, BUY range display (center, when BUY signal exists; empty otherwise), sparkline, current price, today's change, VWAP indicator, signal pill row. **No P&L numbers, no P&L tint, no portfolio weight bar.**

**Held + watchlisted ticker** renders differently per surface — held variant on Portfolio screen card, watchlist variant on each Watchlist screen card the ticker appears on. Same ticker, same `signals` data, two card layouts. Both surfaces query the same `signals` table.

**Signal pills carry ranges in both variants.** Pills render as `[<type> · <quality>% · <motivation> · $<low>-<high>]`. Both SELL and BUY pills render simultaneously when both signals exist. Pill row policy: fit comfortably, wrap if needed, never truncate a signal pill — info badges are the things that get truncated to the +N overflow first.

Primitives extraction is a candidate to land earlier than Track 1 — could fit in MVP polish (Batch 16) as pure refactor, which would make Track 1 a pure compose job.

## Primitives catalog (`client/src/components/primitives/`)

Atomic UI renderers used across screens. Each takes a `size: 'sm' | 'md' | 'lg'` prop so it can scale across card / TickerDetail header / post-MVP chat embed / digest contexts. Implementation may start with only `sm` and add larger sizes when a real consumer needs them — but the API supports them from day one.

| Primitive | Purpose |
|-----------|---------|
| `TickerSymbol` | Symbol text, mono font |
| `CompanyName` | Company name with truncation |
| `PriceValue` | Current price, mono, optional flash-on-change |
| `ChangeAmount` | Dollar + percent change, colored |
| `VWAPIndicator` | Arrow + percent vs VWAP, with "= VWAP" fallback |
| `Sparkline` | 7-day SVG sparkline (44x20px at `sm`) |
| `PnLDisplay` | Combined $/% P&L, colored |
| `SignalPill` | `[type · quality · motivation · range]` |
| `SignalPillRow` | Layout policy + +N overflow |
| `InfoBadge` | Earnings · 12d, etc. |
| `ZoneIcon` | ⇡ glyph with Tooltip |
| `GapBadge` | "GAP" mini-badge |
| `WeightBar` | Portfolio weight bar |
| `BuyRangeDisplay` | "Buy $135-138" |
| `SellRangeDisplay` | "Sell $193-198" |
| `PnLTintBackground` | Wraps children with tinted background, takes `pnlPct` prop |
| `TodayRangeBar` | Low/high range bar with current-price dot |
| `RsiIndicator` | RSI value + bull/bear/neutral badge |
| `PercentDay` | "+0.79%/day" display |

Sparkline note: TickerDetail uses Lightweight Charts (the real chart), NOT Sparkline. Sparkline is for compact card/list contexts only.

---

## Screen 1: Portfolio Home

The main MVP screen. Mobile-first, phone-sized (375-390px viewport).

### Header
- Top-left: "Upside" logo text (18px, weight 500)
- Top-right: Market period badge (tappable dropdown)
  - Shows colored dot + current period: "Pre-market", "Regular", "After-hours", "Closed"
  - Dot colors: amber (pre-market), green (regular), blue (after-hours), gray (closed)
  - Tapping opens dropdown showing exchange groups and their trading windows:
    - NYSE / NASDAQ: Pre-market 4:00–9:30 AM ET, Regular 9:30 AM–4:00 PM ET, After-hours 4:00–8:00 PM ET
  - (Future: LSE, TSE, etc.)
- Header icon buttons: bell (ti-bell, → Alerts feed), settings (ti-settings, → Settings). Chat icon dropped from MVP.
- IB Connection status indicator (small status dot next to market period badge) — see `architecture.md` → Connection Status Header.

### Summary Strip
Two metric cards side by side:
- Left: "Portfolio value" label (11px, muted) + value (18px, weight 500)
- Right: "MTD return" label + value with percent in parentheses, colored green/red, e.g. "+$2,148 (+4.7%)"

### Sort Bar
Three pill-shaped toggles:
- "Signals" — sort by signal urgency (highest-quality actionable signals on top)
- "P&L" — sort by unrealized P&L descending (biggest gains on top)
- "Custom" — user-defined drag-to-reorder, stored in Supabase per user

Active pill: filled dark background, white text. Inactive: outlined, muted text.

### Position Cards (TickerCard, held variant)

Each card represents one held position. Layout:

```
┌──────────────────────────────────────────────┐
│ NVDA       ⇡ +$3,240 (+18.2%)  ▁▂▃▄▅  $140.40 │
│ NVIDIA Corp                          +$1.82 (+1.3%) │
│                                      ↑ +0.8% VWAP │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░ (portfolio weight bar) │
├──────────────────────────────────────────────┤
│ [Sell · 82% · profit · $193-198]              │
│ [Buy · 71% · pullback · $135-138] [Earn 12d]  │
└──────────────────────────────────────────────┘
```

**Left column (~78px min):** ticker symbol (14px, weight 500), company name (10px, tertiary, truncated with ellipsis at ~76px).

**Center area (flex):**
- Optional zone icon (⇡) immediately before the P&L number when `inZone === true`. Tooltip on hover/long-press: "Profit-taking zone — P&L crossed +X% threshold. Consider analyzing."
- Optional "GAP" mini-badge after the zone icon when `entered_zone_via_gap === true` (current trading day only).
- Unrealized P&L combined: `+$3,240 (+18.2%)` (13px, weight 500). Green for gain, red for loss, gray for near-zero (threshold: ±1%).
- Sparkline (44x20px inline SVG) — 7-day price shape. Green stroke for uptrend, red for downtrend, gray for flat. No axes, no labels.

**Right column (~72px min, right-aligned):** current price (14px, weight 500), today's change `+$1.82 (+1.3%)` (10px, colored green/red independently from total P&L), VWAP comparison (10px): arrow + percentage or "= VWAP".

**Portfolio weight bar:** horizontal bar at the bottom of the card, inside the card. Starts from left edge. Width = position's percentage of total portfolio value. Subtle opacity. Color matches P&L tint.

**Background tint:** subtle full-card tint, scales with P&L magnitude:
- 0-1%: gray, opacity 0.04
- 1-5%: green/red, opacity 0.05
- 5-10%: opacity 0.07
- 10-20%: opacity 0.10
- 20%+: opacity 0.14

**Signal + badge row (conditional — only shown when at least one signal or badge exists):**
- Separated by a thin border-top (0.5px).
- Trading signal pills render FIRST in priority order: `[Sell · ...]`, `[Buy · ...]`. Then info badges: `[Earnings · 12d]`, `[Insider · sell]`, `[Vol · 2.3x]`, etc.
- Pill row policy: fit comfortably, wrap to second line if needed for two signals, never truncate a signal pill. Info badges get truncated to a "+N" overflow pill if they don't fit.
- Pill colors: Sell red, Buy green, Event blue, Watch (info badges) amber — see Design System below.
- Chevron-right at far right indicates tap-to-expand. Tapping a signal pill opens Signal Detail (Style A); tapping an info badge opens the relevant section in TickerDetail.

**Cards without any signal or badge** have no signal row — clean, compact card.

### Bottom Navigation Bar

**MVP**: two tabs.
- Portfolio (ti-chart-pie) — active
- Settings (ti-settings)

Alerts (the bell, ti-bell) is a header affordance, not a bottom-nav destination. Chat is dropped from MVP.

**Post-MVP (Track 1)**: bottom nav expands to three tabs:
- Portfolio · Watchlists · Settings

Alerts stays as a header bell icon. Chat may return post-post-MVP as a fourth tab or header affordance (see `roadmap.md` → Track 5).

---

## Screen 2: Ticker Detail

Opens as a full-screen slide-in from the right when tapping a TickerCard. Route: `/ticker/:symbol`.

> **Held vs. unheld tickers render the same screen.** Same layout, same market-stats panel, same chart, same collapsible sections. The only difference: **Position Stats** section is present for held positions and absent for non-held. Everything else renders identically.

### Navigation
- Slide-in animation from right (CSS transform).
- Back arrow (ti-arrow-left) returns to portfolio home.

### Header
- Left: back arrow + ticker symbol (18px, weight 500) + company name (11px, muted).
- Right: current price (18px, weight 500) + today's change in $ and % (12px, colored).

### Today's Range (above chart)
- Label: "Today's range" (left) + "Open $139.20" (right, muted).
- Visual range bar: horizontal track with colored dot showing current price position.
- Low (red, left) / High (green, right). Dot position: `(currentPrice - dayLow) / (dayHigh - dayLow) * 100%`.
- **Data source:** `GET /api/marketdata/snapshot/:symbol` (`dayLow`/`dayHigh`/open) — IB snapshot, Finnhub fallback. Until that endpoint lands these read 0 and the bar is inert (see queue Batch 14e).

### Market Stats (above chart, below today's range)
Dense, customizable stats panel:
- Two rows of four stats each, very compact.
- Each stat: tiny label (10px, muted) + value (11px, weight 500).
- Row 1 default: Vol | P/E | Prev close | Beta
- Row 2 default: Open | EPS | MktCap | AvgVol
- 52-week range bar below stat rows (smaller version of today's range bar).
- "Edit" link (top-right) opens inline customization panel:
  - "Visible" and "Hidden" groups.
  - Each stat: drag handle (ti-grip-vertical) for reordering + toggle switch for visibility.
  - Pool: Volume, Forward P/E, Prior close, Beta, 52-week range, Open, EPS, Market cap, Dividend amount, Dividend date, Put/call interest, Put/call volume, Tweet volume, Avg volume (30d).
  - Selection/order persisted to `user_preferences.stat_config` — applies to ALL ticker screens.
- **Data source:** `GET /api/marketdata/snapshot/:symbol` — the stat pool + 52-week range come from IB fundamentals (Finnhub fallback). Empty until that endpoint lands (queue Batch 14e).

### Chart Controls (between stats and chart)
- Left: Line / Candle toggle.
- Right: VWAP / Vol / RSI indicator toggles.
- Small pill-style buttons, active state = filled.

### Price Chart
- Library: Lightweight Charts by TradingView (free, open source).
- Candlestick and line modes, toggled by Chart Controls.
- Entry price: horizontal dashed amber line at user's avg cost basis, labeled "Avg $XX.XX".
- Entry date: vertical dashed amber marker at purchase date, labeled "Entry [date]" — rendered only when the purchase date falls within the visible timeframe window (otherwise the horizontal avg-cost line alone marks the position).
- VWAP overlay: purple line, toggleable. Intraday only (VWAP resets each session).
- Volume bars at bottom of main chart area, subtle gray, toggleable.
- RSI subchart: separate pane below main chart, toggleable, **computed client-side from the chart's fetched bars** (not the signal engine's snapshot). Overbought (>70) shaded faintly red. Oversold (<30) shaded faintly green. Bands render only when RSI data is present.
- Touch-friendly: pinch-zoom, drag-pan.
- Dark mode compatible.

### Timeframe Bar (below chart)
- Horizontally scrollable pills: 30m, 2h, 1D, 2D, 1W, 1M, 3M, 1Y, 5Y, All.

### Collapsible sections (using shared `CollapsibleSection` component)

**Signal Section** (only if active signal(s) exist):
- Icon: ti-alert-triangle (colored by signal type).
- Header: signal type(s) + Quality (e.g. "Sell · 82%" or "Sell · 82% + Buy · 71%").
- **Collapsed state shows the signal pill row** (same `SignalPill`s as the TickerCard), so the actionable signals stay visible without expanding.
- Body — Style A breakdown:
  - Shared **Indicator analysis** + **Overall reasoning** header (from `analyses.reasoning`).
  - Then per-direction blocks (one each for SELL and BUY if both signals exist on the latest non-superseded analysis):
    - Quality bar (0-100%, colored fill)
    - Timeframe + Target price range
    - Risk/reward ratio
    - Direction-specific rationale (from `signals.rationale`)
    - Indicator status table (per indicator: name | current value | Bullish / Bearish / Neutral badge)
    - "Ask about this signal" button → post-MVP hook for AI chat.
  - If position is `inZone`: inline "Analyze for profit-taking?" shortcut button (triggers normal Analyze flow with `contextualTriggers` auto-attached).
  - "View history" expands to show all prior analyses chronologically.

**Position Stats** (held positions only):
- Icon: ti-wallet.
- Header: total unrealized P&L (right-side, colored).
- Body rows: Shares · Avg cost · Current value · Unrealized P&L ($ and %) · Today's change · Return per day · Portfolio weight · Portfolio contribution · Days held.

**Indicators**:
- Icon: ti-activity.
- Header: bearish/bullish summary count.
- Body rows: RSI (14), VWAP divergence, MACD, Volume trend, Bollinger, Earnings date. Each row: indicator name | current value | colored status badge.

---

## Screen 3: Alerts Feed

Chronological list of signals, zone-entries, and (post-MVP) info-badge events that fired notifications. Accessed via bell icon in header (not bottom nav).

### Top Controls
- **Display filter slider**: "Show signals above ___% Quality" (range: 0-100, default 50). **Display filter only — does NOT affect generation.** Settings has a separate "Signal generation threshold" (the BE-level minimum). Different concepts.
- Filter pills: All / Sell / Buy / Zone-Entry / no_signal.

### Aggregate Accuracy Display (top of feed)
Pulls from `GET /api/signals/accuracy` (Batch 14b). Format: "Recent SELL signals: X% hit-rate over 30d, median +Y% from optimal price." Per-direction stats. Placeholder copy if data is sparse in early days.

### Feed Items
- Timestamp (relative: "2h ago", "Yesterday 3:42 PM").
- Ticker + signal pill badge (or zone-entry pill).
- Short description.
- "I acted on this" button → POST sets `signals.acted_on_at` (or equivalent for zone events). Feeds the post-mortem feature later (see `roadmap.md` → Track 4).
- Tap to open signal detail in TickerDetail.

Empty state: "No signals yet. Tap Analyze on any position to generate one."

---

## Screen 4: Settings (app-level)

> **App-level only. Per-screen settings live on their own screens** (gear icon in screen header → contextual sheet). See `roadmap.md` → Contextual Settings Pattern.

**Settings persistence:** All preferences live in `user_preferences` (see `schema.md`). FE writes through BE (`PUT /api/user/preferences`) for centralized validation. On app load, FE reads once and subscribes to Realtime so multi-device users see changes propagate.

**App-level Settings (MVP scope):**
- **IB Connection**: status indicator (connected/disconnected/session expired/stopped), last sync time, Connect/Disconnect button (uses on-demand IBeam flow — see `architecture.md`).
- **Signal Generation Threshold**: minimum `signalQuality` below which the BE doesn't generate a signal. Acts at generation time. **Distinct from the Alerts feed display filter.**
- **Signal min market value** ($): persists to `user_preferences.signal_min_market_value`.
- **Suppressed symbols**: text list — symbols where Analyze is disabled.
- **Profit-Taking Zone Threshold**: slider 0.5%-10%, default 2%, persists to `user_preferences.profit_zone_threshold_pct`. Determines when a position enters profit-taking zone.
- **Theme**: Dark / Light / System.
- **Analysis engine**: Provider dropdown listing only providers with a key configured on the server (currently Groq; Mistral available) + an optional model field (blank = provider default). Persists to `app_config` via `POST /api/config/llm`, takes effect on the next Analyze (no restart), and syncs across devices via Realtime. API keys stay server-side. See `signal-model.md` → LLM Provider Abstraction.
- **Notifications** (Batch 16): PWA push permission status, quiet-hours toggle. Discord-only is acceptable MVP if scope tightens.
- **Account**: Email, sign out.

---

## Screen 5: Watchlists (POST-MVP — Track 1)

> Not in MVP. Documented at full screen-spec detail so when Track 1 starts, the agent has a build-ready specification. Build details in `roadmap.md` → Track 1.

The Watchlists tab. One screen with horizontal tab strip + selected list's TickerCards below.

### Navigation entry
Bottom nav (3-tab post-MVP layout): Portfolio · **Watchlists** · Settings. Alerts is a bell icon in the top-right header on this screen too.

### Header
- Top-left: "Watchlists" label (18px, weight 500).
- Top-right: bell icon (→ Alerts), gear icon (→ Watchlists-tab contextual settings sheet).

### Sub-tab strip (horizontal scroll)

```
[ Active · ⭐ NVDA Watch · Earnings Week · Megacap · Healthcare · → ]
```

- **Active** pinned leftmost (icon: ⭐ or similar — final glyph TBD). Cannot be hidden, renamed, or deleted.
- Regular watchlists follow in IB-supplied order.
- Hidden watchlists do not appear in the strip — they exist in the data, just not rendered.
- Horizontal scroll if strip overflows. Pinch/drag native.
- Active tab indicator: filled background pill, primary color.

### Body — selected list contents

Below the sub-tab strip, vertical scroll of TickerCards (`variant='watchlist'`).

**Active sub-tab body** renders the two-container Live / Watching layout:

```
┌─ Body when Active is selected ─────────────┐
│                                              │
│ ▼ Live · 2 signals firing now                │
│   [TickerCard NVDA, BUY signal pill]         │
│   [TickerCard AMD, BUY signal pill]          │
│                                              │
│ ▶ Watching · 5 signals not yet in range      │   (tap to expand)
│                                              │
└──────────────────────────────────────────────┘
```

**Live** (expanded by default) — BUY signals where current price ∈ `[priceRangeLow, priceRangeHigh]`. The actionable bucket.
**Watching** (collapsed by default) — BUY signals where the signal is alive but current price is not yet in range.

No proximity threshold — membership is binary based on signal lifecycle (live + non-expired). The "is the price in range right now" check is the only thing that partitions Live from Watching.

**Regular watchlist sub-tab body** renders a flat vertical scroll of TickerCards. No Live/Watching split — that pattern is specific to Active.

### Gear icon — contextual settings sheet (Watchlists-tab-scoped)
- **Unhide watchlists** — checklist of hidden IB watchlists, tap to unhide each.
- (Future) **Reorder visible watchlists** if Upside-side reorder makes sense without conflicting with IB sync.

### Pull-to-refresh
Pulling down on the Watchlists screen triggers an immediate sync against IB (assuming IB is `connected`). If IB is `stopped` or `disconnected`, the pull shows a hint: "Connect IB to refresh."

### Long-press on a TickerCard
Action menu including "Hide from this watchlist" (scoped to current sub-tab only). Standard ticker actions (open detail, etc.).

---

## Screen 6: Single Watchlist (POST-MVP — Track 1)

> "Screen" conceptually but in practice this is Screen 5 with a different sub-tab selected. Listed separately because each watchlist's contents have screen-level semantics (their own gear icon, their own settings sheet, their own action menu).

### Header
Same as Screen 5 — Watchlists label + bell + gear. Gear behavior changes by context.

### Sub-tab strip
Same as Screen 5 — still visible at top, currently-selected tab highlighted.

### Body
Vertical scroll of TickerCards belonging to this specific IB watchlist. TickerCard `variant='watchlist'`.

### Gear icon — contextual settings sheet (scoped to *this* watchlist)
- **Unhide tickers in this watchlist** — checklist of tickers hidden specifically from this watchlist. Hiding is per-watchlist (same ticker on another watchlist is unaffected).
- Display preferences specific to this watchlist (if any emerge during implementation).

### Empty state
"No tickers visible. The IB watchlist is empty, or you've hidden them all. Tap the gear icon to unhide."

---

## Design System

### Aesthetic Direction
Refined minimalism with a financial-grade feel. Bloomberg terminal meets modern mobile. Dense but not cluttered. Every pixel earns its place.

### Typography
- Distinctive sans-serif — NOT Inter, Roboto, or Arial. Consider: DM Sans, Manrope, Plus Jakarta Sans, or Outfit.
- Monospace for prices and numbers: JetBrains Mono, IBM Plex Mono, or Fira Code.
- Sizes: 18px (header values), 14px (ticker/price), 13px (P&L), 11-12px (secondary), 10px (tertiary/labels).
- Two weights only: 400 (regular), 500 (medium). Never 600 or 700.

### Colors
- Gain: #639922 (green-600)
- Loss: #E24B4A (red-400)
- Near-zero: #888780 (gray-400)
- VWAP above: green. VWAP below: red.
- Signal pills:
  - Sell: bg #FCEBEB / text #791F1F (dark: bg #501313 / text #F09595)
  - Buy: bg #EAF3DE / text #27500A (dark: bg #173404 / text #97C459)
  - Event: bg #E6F1FB / text #0C447C (dark: bg #042C53 / text #85B7EB)
  - Watch (info badges): bg #FAEEDA / text #633806 (dark: bg #412402 / text #FAC775)
- Backgrounds: CSS variables for light/dark mode support.
- Card borders: 0.5px solid, subtle.

### Dark Mode
Must be fully supported. All colors must work in both modes. CSS variables throughout.

### Spacing
- Card padding: 10-12px vertical, 12-14px horizontal.
- Card gap: 6px between cards.
- Card border-radius: 8px (md).
- Section spacing: 14px between major sections.

### Animations
- Card tap: subtle scale(0.98) on press.
- Sparklines: draw-in animation on load (CSS stroke-dasharray/dashoffset).
- Price updates: brief flash/highlight when price changes.
- Sort transitions: smooth reorder when switching sort views.

---

## PWA Requirements

- Service worker for offline caching (show last-known portfolio state).
- Web app manifest for home screen installation.
- Push notification support via Web Push API (Batch 16).
- Responsive: optimized for 375-430px width (iPhone/Android), usable on desktop.
- Target: <2s initial load, <500ms subsequent navigations.

---

## Key Metrics & Calculations

### P&L Tint Opacity
```ts
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
```ts
function getPnlColor(pnlPercent: number): 'gain' | 'loss' | 'neutral' {
  if (pnlPercent > 1) return 'gain';
  if (pnlPercent < -1) return 'loss';
  return 'neutral';
}
```

### Zone Membership
```ts
function isInZone(pnlPercent: number, thresholdPct: number): boolean {
  return pnlPercent >= thresholdPct;
}

// On each positions write:
//   wasInZone = (priorRow.zone_entered_at !== null);
//   nowInZone = isInZone(newPnlPct, prefs.profit_zone_threshold_pct);
//   if (!wasInZone && nowInZone) {
//     zone_entered_at = now();
//     entered_zone_via_gap = (now() < todays_market_open);
//     maybeFireDiscordNotification();  // with 4h cooldown
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
// > 0.1%: green up-arrow + "+X.X% VWAP"
// < -0.1%: red down-arrow + "-X.X% VWAP"
// Else: "= VWAP" in gray
```

### Portfolio Weight Bar
```
weightPercent = positionMarketValue / totalPortfolioValue * 100
// Horizontal bar at bottom of card, width = weightPercent%, color matches P&L tint
```
