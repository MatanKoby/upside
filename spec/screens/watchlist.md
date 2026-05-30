# Watchlist (Track 1, moved into MVP)

> **Moved into MVP via the 2026-05-28 watchlist pivot.** Was post-MVP Track 1; LLM-signal refinements are deferred behind this. See `../roadmap.md`.

The Watchlist tab. One screen with a horizontal sub-tab strip (one tab per active imported list) + ticker rows below. User-defined markers and (Batch A+) dynamic entry zones drive Discord alerts without an LLM.

## Navigation entry

Bottom nav (Portfolio · **Watchlist** · Settings). Alerts is a bell icon in the top-right header on this screen too.

## First-time empty state

```
You haven't imported any watchlists yet.

[ Import from IB ]
```

Tap → `POST /api/watchlists/import` syncs the user's IB watchlists (user_lists only; system_lists like "All US Stocks" are skipped — Batch 13.2 captured the filter). All imported lists default to **hidden**. The Watchlist screen shows the empty state with a hint until at least one list is unhidden.

## Header

- Top-left: "Watchlist" label (18px, weight 500).
- Top-right: bell icon (→ Alerts), gear icon (→ Watchlist-tab contextual settings sheet).

## Sub-tab strip (horizontal scroll)

```
[ Megacap · Dividends · Earnings Week · → ]
```

- One sub-tab per **active** imported list (in IB-supplied order).
- Hidden lists do not appear in the strip — they exist in the data, just not rendered.
- Horizontal scroll if strip overflows.
- Active tab indicator: filled background pill, primary color.

## Body — selected list contents

Vertical scroll of TickerCards (`variant='watchlist'` — see `_design-system.md`).

Each row shows: ticker · company · current price (canonical quote) · today's change · sparkline · **marker chips** (user-defined `../signals/markers.md`) · **entry-zone chip** (Batch A+; `../signals/entry-zones.md` — collapsed overnight chip with hover/tap popover for all three horizons) · **intraday-stats chip** (Batch B; `../signals/stats.md` — today's drop vs. typical-intraday-low band, color-coded `above` / `typical` / `deep`) · optional signal pill if an active analysis exists.

Layout: left container (symbol + company, max 200px / 35%) → sparkline → chip cluster (`margin-left: auto`, max 55%, flex-wrap) → absolutely-positioned right column (price + %-change + source pill). Chip cluster keeps all chips on one row (`white-space: nowrap`) even with long `$1234.56` prices.

## Gestures

- **Tap** a row → navigates to TickerDetail (which works for non-held tickers — see `ticker-detail.md`).
- **Long-press** (mobile) / **right-click** (desktop) on a row → opens the add-marker sheet directly. Pre-fills `condition: at_or_below` (the dip-buy default), price field empty.
- **Tap a marker chip** → edit / delete sheet.
- **Tap an entry-zone chip** → expands a popover with reasoning + confidence + recent firings + "Promote to manual marker" action.

## Add-marker sheet

```
┌── Add marker · NVDA ─────────────────────┐
│  Label (optional):  [ earnings entry  ]  │
│  Price:             [ $ 135.00       ]   │
│  Condition:         ( ) at_or_above       │
│                     (•) at_or_below       │   ← default
│                     ( ) about              │
│  Cooldown:          [ 24 ] hours          │
│                                            │
│        [ Cancel ]      [ Add marker ]      │
└────────────────────────────────────────────┘
```

Marker schema + alert flow: see `../signals/markers.md`. First-cut alerts wire only `at_or_below` markers → `#upside-dip-buys`.

## Pull-to-refresh

Pulling down triggers `POST /api/watchlists/sync` against IB (assuming IB is `connected`). If IB is `stopped`/`disconnected`, the pull shows a hint: "Connect IB to refresh lists." Marker alerts and price polling do NOT require IB on (Finnhub keeps prices flowing).

## Glossary (?-icon in header)

Help icon (`ti-help-circle`) in the header opens a glossary sheet defining the
indicators and chip semantics used on the screen — ATR, RSI, SMAs, pivots,
Bollinger, VWAP, swing lows, confluence, horizons, overbought-tightened,
marker conditions, intraday-stats band. Lives in
`components/Watchlist/Glossary.tsx`.

## Gear icon — contextual settings sheet (Watchlist-tab-scoped)

- **Active / hidden toggle per imported list** — checklist of all imported lists with a toggle each. Active lists' tickers join the price-polling loop and render as sub-tabs; hidden lists don't (no polling, no UI).
- **Re-import from IB** — re-sync the list catalog.
- **Per-list display preferences** (future).

## Held + watchlisted tickers

A ticker that appears in both Portfolio (held) and a watchlist renders in both surfaces — held variant on the Portfolio card, watchlist variant on the Watchlist row. Both surfaces query the same canonical quote and `signals` table.
