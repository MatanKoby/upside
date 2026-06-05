# Ticker Detail

Opens as a full-screen slide-in from the right when tapping a TickerCard. Route: `/ticker/:symbol`.

> **Held vs. non-held tickers render the same screen.** Same layout, same Market Stats panel, same chart, same collapsible sections. Differences:
> - **Position Stats** section is present for held positions and absent (hidden) when no shares.
> - Non-held tickers don't appear in Portfolio's positions list.
> Header, chart, Today's Range, Market Stats, Signal section, Indicators all render identically. Requires `useTickerDetail` to resolve a price for any tracked conid — held or watchlist — via the canonical quote (`quotes.canonical_price` post-Track-1; `positions.current_price` MVP-today). See `../architecture.md` → Single source of truth.

> ⚠ **Loading / error states (deferred — Batch 16 scope):** `TickerDetailPage` currently reuses the `ComingSoon` placeholder for loading / error / not-held branches. Replace with proper states: skeleton/spinner while loading, real error card on failure, distinct "not in your portfolio" empty state.

## Navigation
- Slide-in animation from right (CSS transform).
- Back arrow (ti-arrow-left) returns to portfolio home (or watchlist, depending on origin).

## Header
- Left: back arrow + ticker symbol (18px, weight 500) + company name (11px, muted).
- Right: current price (18px, weight 500) + today's change in $ and % (12px, colored).
- **Price source**: the canonical quote (poller-maintained). The header is the single source of truth for "current price"; chart and Today's-Range read this same value.

## Today's Range (above chart)
- Label: "Today's range" (left) + "Open $139.20" (right, muted).
- Visual range bar: horizontal track with colored dot showing current price position.
- Low (red, left) / High (green, right). Dot position: `(currentPrice - dayLow) / (dayHigh - dayLow) * 100%`.
- **Data source:** `GET /api/marketdata/snapshot/:symbol` — IB-primary, Finnhub-fallback. **Canonical for user-facing market stats** (see `../architecture.md` → Single source of truth). `currentInRange` is computed FE-side from the canonical live price.

## Market Stats (above chart, below today's range)

Dense, customizable stats panel:
- 4-per-row grid (wraps to as many rows as there are enabled stats).
- Each stat: tiny label (10px, muted) + value (11px, weight 500).
- Row 1 default: Vol | P/E | Prev close | Beta
- Row 2 default: Open | EPS | 52w range | MktCap
- Row 3 default: AvgVol | Dividend
- 52-week range is a **text cell** (`$3.01–$9.39`) in the grid.
- "Edit" link (top-right) opens inline customization panel; selection/order persisted to `user_preferences.stat_config`.
- **Data source:** `GET /api/marketdata/snapshot/:symbol` (the user-facing canonical). The stat pool + 52-week range come from Finnhub `/stock/metric` (basic financials), not IB. Volume is IB-only (Finnhub free `/quote` omits it → "—" when IB is off).

## Refresh policy (multi-source-of-truth cleanup)

While TickerDetail is open, the FE polls `/api/marketdata/history` and `/api/marketdata/snapshot` on a ~30s interval so the chart, VWAP/RSI overlays, Today's Range, and Market Stats track live rather than freezing at mount. Header price stays Realtime-driven from the canonical quote.

## Chart Controls (between stats and chart)
- Left: Line / Candle toggle.
- Right: VWAP / Vol / RSI indicator toggles.
- Small pill-style buttons, active state = filled.

## Price Chart

- Library: Lightweight Charts by TradingView (free, open source).
- Candlestick and line modes, toggled by Chart Controls.
- **Live price line** at the canonical quote (header's value), labeled with the live price. The chart's last-candle axis label is suppressed (`lastValueVisible: false` on the candle + line series) so it stops asserting a competing price.
- Entry price: horizontal dashed amber line at user's avg cost basis (held only), labeled "Avg $XX.XX".
- Entry date: vertical dashed amber marker at purchase date, labeled "Entry [date]" — rendered only when the purchase date falls within the visible window.
- VWAP overlay: purple line, toggleable. Intraday only.
- Volume bars at bottom of main chart area, subtle gray, toggleable. No last-value price tag on the histogram.
- **RSI subchart**: separate pane below main chart, toggleable, **computed client-side from the chart's fetched bars** — purely visualization (see `../architecture.md` → Single source of truth: per-bar series). Overbought (>70) shaded faintly red. Oversold (<30) shaded faintly green.
- Touch-friendly: pinch-zoom, drag-pan. Dark mode compatible.

## Timeframe Bar (below chart)
- Horizontally scrollable pills: 30m, 2h, 1D, 2D, 1W, 1M, 3M, 1Y, 5Y, All.

## Collapsible sections (using shared `CollapsibleSection` component)

**Risk flags** (any ticker with an active `risk_flags` row — see `../signals/risk-flags.md`):
- Icon: ti-alert-triangle (red for CRITICAL, amber for WARNING).
- Header: severity + count ("⚠ 2 risk flags · CRITICAL"). Renders **expanded by default** when CRITICAL.
- Body: one row per active flag — flag name · one-line plain-language explanation (e.g. "Up 31% over 5 sessions — momentum, no fundamental anchor") · "since <date>". The threshold that fired is shown inline so it's legible against the user's tunable settings.
- Section absent when no `risk_flags` row exists (clean ticker). Data wiring: `useRiskFlags(conid)` — single-row `maybeSingle` on `risk_flags` for today + a Realtime sub.

**Signal Section** — single-direction **playbook** (see `../signals/playbook.md`):
- Icon: ti-alert-triangle (colored by direction).
- Header: direction + Quality + horizon (e.g. "Sell · 78% · ⏱ Intraday"). The one signal pill renders in the collapsed header so the immediate action stays visible.
- Body:
  - **Overall thesis** (from `analyses.reasoning`).
  - **Playbook** — the ordered legs, each: action · price (with condition) · per-leg confidence · one-line reasoning.
  - **Live leg status (14h):** each leg shows ✓ hit / ✗ missed (with the actual extreme) / ⋯ pending.
  - **Indicator readings table** — see Indicators section below.
  - "View history" expands prior analyses chronologically.
- **Actions:** when no active signal → one **Analyze** button. When an active signal exists → **Refine** + **Re-analyze (fresh)**. Both use the two-step friction + soft-block + daily ceiling + freshness guard (see `../signals/playbook.md`).
- **Pre-analysis gate (CRITICAL risk flag):** when the ticker has a CRITICAL `risk_flags` row, tapping Analyze / Refine first opens a DANGER modal — *"⚠ {SYMBOL} is up {X}% in {N} days with {flags}. Momentum plays have high reversal risk. Proceed?"* — requiring an explicit confirm before the normal two-step friction runs. Friction, not a silent override; the BE confidence clamp (`../signals/playbook.md` → Risk-flag context + confidence cap) is the backstop for when the user proceeds. WARNING flags do not gate — they surface in the Risk-flags section only.

**Markers** (non-held tickers / watchlist) — see `../signals/markers.md`:
- Icon: ti-tag.
- Header: count of active markers ("3 markers · 1 dip-buy").
- Body: rows showing label · $price · condition · 24h cooldown state. Tap a row → edit sheet.
- Empty state: "No markers yet — long-press the ticker on the watchlist to add one."

**Entry zones** (non-held tickers / watchlist, A+) — see `../signals/entry-zones.md`:
- Icon: ti-target.
- Header: current intraday entry chip.
- Body: three horizon rows (intraday / overnight / multiday) — price · reasoning · confidence · live-fire history.

**Intraday stats** (any ticker with a populated `intraday_stats` row, B) — see `../signals/stats.md`:
- Icon: ti-chart-bar.
- Header: collapsed (no accessory).
- Body: 3×3 table — three stats (open fade / close fade / intraday low) × three columns (Mean / Typical p50 / Extreme p25-for-fades or p75-for-low). Footnote shows `<lookback>d lookback · n=<sample_size> sessions · computed <ts>`.
- Empty state: explicit nightly-cron explanation rather than em-dashes per cell.
- Data wiring: `useIntradayStats(symbol)` — queries `intraday_stats` by the `symbol` index (single-row maybeSingle + a Realtime sub for nightly updates).

**Position Stats** (held positions only):
- Icon: ti-wallet.
- Header: total unrealized P&L (right-side, colored).
- Body rows: Shares · Avg cost · Current value · Unrealized P&L ($ and %) · Today's change · Return per day · Portfolio weight · Portfolio contribution · Days held.

**Indicators**:
- Icon: ti-activity.
- Header: bearish/bullish summary count.
- Body rows: RSI (14), VWAP divergence, MACD, Volume trend, Bollinger, Earnings date. Each row: indicator name | current value | colored status badge.
- **Data source: latest non-superseded `analyses.indicator_snapshot`** for this (user, symbol). The chart's client-side RSI/VWAP series are visualization-only and don't feed this section (compute-once / canonical-for-scalar — see `../architecture.md` → Single source of truth).
- Pre-Analyze (no analysis yet): empty state — "Analyze to compute indicators."
