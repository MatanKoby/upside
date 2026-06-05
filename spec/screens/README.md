# `spec/screens/` — UI surfaces

One file per screen + a shared design system. When two sections always change in tandem, they belong in the same file. When a new screen warrants its own file, add it here and update this README.

## Files

- **`_design-system.md`** — Typography, colors, dark mode, spacing, primitives catalog, TickerCard, PWA, metrics formulas. Read first when designing or polishing any screen.
- **`portfolio.md`** — Portfolio Home (held positions).
- **`ticker-detail.md`** — Ticker Detail (works for held AND watchlist tickers).
- **`watchlist.md`** — Watchlist tab (Track 1, moved into MVP via the 2026-05-28 pivot).
- **`screener.md`** — **Retired 2026-06-05** (redirect). The Screener tab folded into the Watchlist screen as Upside-curated virtual lists (Intraday / Swing) — see `watchlist.md` → Upside-curated virtual lists.
- **`alerts.md`** — Alerts feed.
- **`settings.md`** — App-level Settings.

## Cross-references

- Signal engines feeding these screens: `../signals/README.md`
- Data flow per screen: `../flows.md`
- Tables read by these screens: `../schema.md`
