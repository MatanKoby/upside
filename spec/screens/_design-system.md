# Design System + Primitives + PWA + Metrics

Shared bedrock for all screens. Typography, color, the primitives catalog used across cards, PWA requirements, and the calculation formulas used by multiple surfaces.

## TickerCard (shared component)

A single component used across the Portfolio screen, the Watchlist screen, and anywhere else a ticker is rendered as a card row. Variant prop discriminates rendering:

```ts
type TickerCardVariant =
  | { kind: 'held'; position: Position; signals: Signal[] }
  | { kind: 'watchlist'; ticker: WatchlistTicker; signals: Signal[]; markers: Marker[] };
```

Single component, internal branching on a few conditionals (P&L tint vs. none, weight bar vs. none, center area as P&L vs. BUY range vs. marker chips).

**Held variant** renders: ticker, company, P&L combined (center), sparkline, current price, today's change, VWAP indicator, portfolio weight bar (bottom), signal pill row. P&L tint background scales with magnitude. Optional zone icon + GAP badge before P&L when `inZone` (see `../signals/zone.md`).

**Watchlist variant** renders: ticker, company, current price (right), today's change, sparkline, marker chips (user-defined markers + dynamic entry-zone chips from `../signals/entry-zones.md`), signal pill row when an active signal exists. **No P&L numbers, no P&L tint, no portfolio weight bar.**

**Held + watchlisted ticker**: held variant on Portfolio, watchlist variant on the Watchlist tab. Same ticker, two card layouts.

**Signal pills carry the immediate action.** Pill format `[<type> · <quality>% · <motivation> · $<price>]` (leg 1 of the playbook). Pill row policy: never truncate a signal pill — info badges truncate to "+N" first.

## Primitives catalog (`client/src/components/primitives/`)

Atomic UI renderers. Each takes a `size: 'sm' | 'md' | 'lg'` prop so it can scale across card / TickerDetail header / future contexts. Implementation may start with only `sm` and add larger sizes when a real consumer needs them.

| Primitive | Purpose |
|-----------|---------|
| `TickerSymbol` | Symbol text, mono font |
| `CompanyName` | Company name with truncation |
| `PriceValue` | Current price, mono, optional flash-on-change |
| `ChangeAmount` | Dollar + percent change, colored |
| `VWAPIndicator` | Arrow + percent vs VWAP, with "= VWAP" fallback |
| `Sparkline` | 7-day SVG sparkline (44x20px at `sm`) |
| `PnLDisplay` | Combined $/% P&L, colored |
| `SignalPill` | `[type · quality · motivation · price]` |
| `SignalPillRow` | Layout policy + +N overflow |
| `InfoBadge` | Earnings · 12d, etc. |
| `MarkerChip` | User-defined marker (label · $price · condition glyph) — see `../signals/markers.md` |
| `EntryZoneChip` | Dynamic entry chip (`I/O/M: $price`) — see `../signals/entry-zones.md` |
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

## Aesthetic Direction

Refined minimalism with a financial-grade feel. Bloomberg terminal meets modern mobile. Dense but not cluttered. Every pixel earns its place.

## Typography

- Distinctive sans-serif — NOT Inter, Roboto, or Arial. Consider: DM Sans, Manrope, Plus Jakarta Sans, or Outfit.
- Monospace for prices and numbers: JetBrains Mono, IBM Plex Mono, or Fira Code.
- Sizes: 18px (header values), 14px (ticker/price), 13px (P&L), 11-12px (secondary), 10px (tertiary/labels).
- Two weights only: 400 (regular), 500 (medium). Never 600 or 700.

## Colors

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

## Dark Mode

Must be fully supported. All colors must work in both modes. CSS variables throughout.

## Spacing

- Card padding: 10-12px vertical, 12-14px horizontal.
- Card gap: 6px between cards.
- Card border-radius: 8px (md).
- Section spacing: 14px between major sections.

## Animations

- Card tap: subtle scale(0.98) on press.
- Sparklines: draw-in animation on load (CSS stroke-dasharray/dashoffset).
- Price updates: brief flash/highlight when price changes.
- Sort transitions: smooth reorder when switching sort views.

## PWA Requirements

- Service worker for offline caching (show last-known portfolio state).
- Web app manifest for home screen installation.
- Push notification support via Web Push API (Batch 16).
- Responsive: optimized for 375-430px width (iPhone/Android), usable on desktop.
- Target: <2s initial load, <500ms subsequent navigations.

## Key Metrics & Calculations

### P&L Tint Opacity
```ts
function getTintOpacity(pnlPercent: number): number {
  const abs = Math.abs(pnlPercent);
  if (abs < 1) return 0.04;
  if (abs < 5) return 0.05;
  if (abs < 10) return 0.07;
  if (abs < 20) return 0.10;
  return 0.14;
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
```

### VWAP Comparison
```
vwapDiff = ((currentPrice - vwap) / vwap) * 100
// > 0.1%: green up-arrow; < -0.1%: red down-arrow; else "= VWAP"
```
