# Screener Tab

The FE surface for the intraday-scalping screener. Renders the daily virtual
watchlists materialized by `signals/screener-universe.md` (one list per
trait) with live walking bands from `signals/band-engine.md`. The user's
day starts here — glance at the lists, decide which names are worth
promoting into the persistent Watchlist or setting a marker on.

Sibling spec files: `watchlist.md` (the user-curated cousin),
`_design-system.md` (TickerCard primitives + typography),
`../signals/screener-universe.md` (the data model),
`../signals/band-engine.md` (what the band chips render).

## Navigation entry

Bottom nav (Portfolio · Watchlist · **Screener** · Settings). New tab,
positioned between Watchlist and Settings — closer to Watchlist because
it's the same "tickers I might trade" cognitive space.

Alerts bell sits in the top-right header on this screen too, same pattern
as Watchlist and Portfolio.

## First-time / empty state

```
The screener is still warming up.

Nightly sweep runs at 09:00 IDT — come back after that
for today's intraday-range-traders, catalyst reversals,
and post-earnings movers.
```

Shown when no `trait_scores` rows exist for `asof_date = today`. After the
first nightly sweep completes the tab populates automatically.

## Header

- Top-left: "Screener" label (18px, weight 500).
- Top-right: bell icon (→ Alerts), gear icon (→ Screener-tab contextual
  settings sheet — trait visibility, list size, sort preference).

Status sub-row beneath the header shows last refresh: `last refreshed
15:32 IDT · 87 names across 3 lists`. Becomes red text if the refresh is
stale (> 24h since nightly sweep, or > 6h since pre-mkt sweep during
session hours).

## Body — vertical accordions, one per trait

```
▾ Today's range-traders (12)         [details]
   REPL    $7.82  ▼ 0.6%   p50 band $7.71   60d sample  ▲
   MNTS    $19.20 ▲ 1.1%   p50 band $17.96  vol-regime  ⚠
   …
   Show all 30

▸ Catalyst reversals (3)             [details]
▸ Post-earnings drift (8)            [details]
```

- One collapsible section per trait — `intraday_range_trader`,
  `catalyst_reversal`, `post_earnings_drift`. Order: most actionable first
  (catalyst_reversal at top when populated, range-traders default, drift
  last).
- Default render: top 5 rows per trait by score. "Show all 30" expands the
  list. "[details]" affordance opens the trait's glossary entry (what the
  rule is, how scoring works — same `Glossary` pattern Watchlist uses).
- Empty traits collapse to a single-line summary: "Catalyst reversals — none
  today" so the user knows the trait ran but produced nothing.

## Ticker row

Same `TickerCard` primitive used in Watchlist (`variant='screener'`), with
trait-specific payload chips. From left to right:

1. Symbol + brief company name (16ch ellipsis), price (with `PriceFlicker`
   animation — see `common/PriceFlicker`), today's change %.
2. Trait-specific chip cluster:
   - `intraday_range_trader`: `IntradayStatsChip` (existing) + the p50 buy
     band as a small "$X.XX band" text.
   - `catalyst_reversal`: gap multiplier badge ("3.2× vol"), intraday move
     pct, beaten-down basis ("RSI 28 · 32% off 52w").
   - `post_earnings_drift`: days-since-earnings ("2d ago") + report-day pop
     pct.
3. `MiniSparkline` (existing, 7d daily closes).
4. **Walking band annotations** (when the band engine has published for
   today): tiny chip showing `session_regime` (mean_reversion / bullish /
   bearish / mixed) and `vol_scalar` annotation (`high vol` / `calm` /
   `vol regime shift`). Tap chip → opens a small popover with the next
   predicted low/high bands.

Tapping the row navigates to `/ticker/:symbol` (same as Watchlist).

## Row affordances

- **Long-press / right-click**: opens a sheet with two actions:
  - **Add to Watchlist** — prompts to pick which existing watchlist (or
    create a new "Screener picks" one), then writes a `watchlist_items` row.
    Ticker stays on the screener list until its trait stops firing; now
    also appears in the chosen watchlist.
  - **Set a marker** — opens the same `MarkerSheet` as Watchlist
    (`signals/markers.md`), prefilled with the band engine's published p50
    buy band as the marker price.
- **Tap on a band chip**: opens a small popover (same component as
  Watchlist's entry-zone cluster popover) showing the published low and
  high bands with the session_regime + vol-scalar annotations.

## Contextual settings sheet (gear icon)

- **Visible traits** — toggle each trait on/off (lets the user mute
  `post_earnings_drift` if it's noisy without affecting nightly compute).
- **List size** — top-5 default / top-10 / top-30. Per-trait.
- **Sort** — score (default) / alphabetical / price ascending.
- **Hide tickers in my Watchlist** — toggle. When on, tickers already in
  any active Watchlist are filtered out of the screener tab (deduplicates
  the surface).

## Loading & error states

Skeleton rows for the row list during initial paint. The header + tabs +
trait section labels remain visible immediately (per the user's
loading-state preference). On a Realtime subscription error, the affected
trait section shows a small "couldn't refresh — retrying" banner; the
cached row data stays visible.

## What this screen doesn't render

- Held position context — that's the Portfolio screen.
- LLM analyses — those are TickerDetail-only.
- The static intraday-stats panel — that's TickerDetail's "Intraday stats"
  collapsible (`ticker-detail.md`).
