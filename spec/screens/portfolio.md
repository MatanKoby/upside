# Portfolio Home

The main MVP screen. Mobile-first, phone-sized (375-390px viewport).

## Header
- Top-left: "Upside" logo text (18px, weight 500)
- Top-right: Market period badge (tappable dropdown)
  - Shows colored dot + current period: "Pre-market", "Regular", "After-hours", "Closed"
  - Dot colors: amber (pre-market), green (regular), blue (after-hours), gray (closed)
  - Tapping opens dropdown showing exchange groups and their trading windows:
    - NYSE / NASDAQ: Pre-market 4:00–9:30 AM ET, Regular 9:30 AM–4:00 PM ET, After-hours 4:00–8:00 PM ET
- Header icon buttons: bell (ti-bell, → Alerts feed), settings (ti-settings, → Settings).
- IB Connection status indicator (small status dot next to market period badge) — see `../architecture.md` → Connection Status Header.

## Summary Strip
Single card (was two; the MTD card was removed 2026-05-29 — Redis-cached month-start fallback was unreliable in practice and the user's primary mental anchor is current value, not MTD):
- "Portfolio value" label (11px, muted) + value (18px, weight 500).

> If MTD comes back, the prior design was a right-side card with "MTD return" + percent in parentheses, colored green/red. Source: IB account summary's MTD field with Redis-cached month-start fallback (see `../schema.md` → Redis usage).

## Sort Bar
Three pill-shaped toggles:
- "Signals" — sort by signal urgency (highest-quality actionable signals on top)
- "P&L" — sort by unrealized P&L descending
- "Custom" — user-defined drag-to-reorder, stored in Supabase per user

Active pill: filled dark background, white text. Inactive: outlined, muted text.

## Position Cards (TickerCard, held variant)

Each card represents one held position. See `_design-system.md` → TickerCard for the shared component spec.

**Center area** — Optional zone icon (⇡) immediately before P&L when `inZone === true` (`../signals/zone.md`). Optional "GAP" mini-badge after the zone icon when `entered_zone_via_gap === true` (current trading day only). Unrealized P&L combined `+$3,240 (+18.2%)` (13px, weight 500). Sparkline (44x20px) — 7-day price shape.

**Right column** (~72px min, right-aligned): current price (14px, weight 500), today's change `+$1.82 (+1.3%)` (10px), VWAP comparison (10px): arrow + percentage or "= VWAP".

**Portfolio weight bar** — horizontal bar at the bottom inside the card. Width = position's percentage of total portfolio value.

**Background tint** scales with P&L magnitude — see `_design-system.md` → P&L Tint Opacity.

**Signal + badge row** (conditional — only when at least one signal, badge, or **risk flag** exists):
- Separated by a thin border-top (0.5px).
- **Danger badge** renders FIRST when ≥1 risk flag is active (`../signals/risk-flags.md`) — a distinct pill **separate from the signal pill**: red for CRITICAL, amber for WARNING, labelled with the dominant flag (e.g. "⚠ Pump" / "⚠ Earnings 3d") and a "+N" when multiple flags stack. Never truncated (same policy as signal pills). Reads `risk_flags` via Realtime. Tapping it opens the Risk-flags section in TickerDetail.
- Trading signal pills render next in priority order. Then info badges.
- Pill row policy: fit comfortably, wrap to second line, never truncate a signal pill or the danger badge. Info badges get truncated to a "+N" overflow pill.
- Chevron-right at far right indicates tap-to-expand. Tapping a signal pill opens the Signal section in TickerDetail.

Cards without any signal, badge, or risk flag have no signal row — clean, compact.

**Ticker symbol gesture** — long-press / right-click the symbol text → opens Robinhood for that ticker in a new tab (`_design-system.md` → Long-press the ticker symbol → Robinhood). A plain tap on the card still opens TickerDetail.

## Bottom Navigation Bar

Three tabs (watchlist pivot, 2026-05-28):
- **Portfolio** (ti-chart-pie)
- **Watchlist** (icon TBD during FE implementation)
- **Settings** (ti-settings)

Alerts (the bell, ti-bell) is a header affordance, not a bottom-nav destination. Chat is dropped from MVP.
