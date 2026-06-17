# Watchlist (Track 1, moved into MVP)

> **Moved into MVP via the 2026-05-28 watchlist pivot.** Was post-MVP Track 1; LLM-signal refinements are deferred behind this. See `../roadmap.md`.

The Watchlist tab. One screen with a horizontal sub-tab strip + ticker rows below. The strip carries **two Upside-curated virtual lists** (Intraday / Swing — the retired Screener tab folded in here, 2026-06-05) followed by one tab per active imported list. User-defined markers and (Batch A+) dynamic entry zones drive Discord alerts without an LLM.

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
[ Intraday ✨ · Swing ✨ · Megacap · Dividends · Earnings Week · → ]
```

- **Two Upside-curated virtual tabs first** (Intraday ✨ / Swing ✨ — see below), always present, then one sub-tab per **active** imported list (in IB-supplied order).
- Hidden imported lists do not appear in the strip — they exist in the data, just not rendered. The virtual tabs can't be hidden.
- Horizontal scroll if strip overflows.
- Active tab indicator: filled background pill, primary color.

## Body — selected list contents

Vertical scroll of TickerCards (`variant='watchlist'` — see `_design-system.md`).

Each row shows: ticker · company · current price (canonical quote) · today's change · sparkline · **danger badge** (risk flags `../signals/risk-flags.md` — red CRITICAL / amber WARNING, separate from the signal pill, never truncated) · **marker chips** (user-defined `../signals/markers.md`) · **entry-zone chip** (Batch A+; `../signals/entry-zones.md` — collapsed overnight chip with hover/tap popover for all three horizons) · **intraday-stats chip** (Batch B; `../signals/stats.md` — today's drop vs. typical-intraday-low band, color-coded `above` / `typical` / `deep`) · optional signal pill if an active analysis exists.

Layout: left container (symbol + company, max 200px / 35%) → sparkline → chip cluster (`margin-left: auto`, max 55%, flex-wrap) → absolutely-positioned right column (price + %-change + source pill). Chip cluster keeps all chips on one row (`white-space: nowrap`) even with long `$1234.56` prices.

## Upside-curated virtual lists (Intraday / Swing)

Two always-present virtual tabs Upside maintains (no IB import) — the dip-bounce track's output, rendered as **living leaderboards**:

- **Intraday** — names with intraday-tradeable potential, ranked by a composite intraday-opportunity score.
- **Swing** — names with multi-day potential, ranked by a composite swing-opportunity score.

**Living, not frozen.** Rows re-rank on the poll cycle through the session (scores update every cycle; the walking band ticks every 5 min). A name that loses its potential falls in rank and loses its live marker — so an end-of-day glance reflects EoD, not the open. The underlying pool is rebuilt daily (`../signals/curated-list.md`); the *ranking* is intraday.

**Membership age badge (Batch X9).** The lists render the **latest available** daily pool, not strictly today's. When that pool is older than today (weekend / pre-market / a missed sweep), the tab shows an **"as of <date>" badge**; past the staleness cap (~2-3 trading days) it goes to a "data stale" state rather than silently serving old membership. Stale membership can *display*; only a fresh price can *fire* a marker (`../signals/dip-bounce-scorer.md` → Fresh-price firing gate).

**Why a ticker is on the list — reason chips.** Each row carries one or more `why` chips for the trait(s) that qualified it (`../signals/screener-universe.md`):
- `dip` — `intraday_range_trader` character → **Intraday**.
- `catalyst` — `catalyst_reversal` event → **BOTH lists** (day-long volume spikes are intraday-tradeable *and* can run for days).
- `post-earnings` — `post_earnings_drift` → **Swing**.

A name can carry multiple chips and appear on both lists. The list rank is a **composite** (dip-bounce score for character names + the trait's own score for event names) — see `../signals/dip-bounce-scorer.md` → Feeding the virtual lists.

**Fired marker.** A name that just crossed its dip-bounce alert threshold (`../signals/dip-bounce-scorer.md`) shows a live **⚡ just fired** marker on its row — the alert-log view collapsed into the leaderboard rather than a separate surface.

**Row extras (vs imported rows):** a **rolling 30-day hit-rate** column (forward-tracker, `../signals/dip-bounce-scorer.md`) + a **walking-band chip** (`../signals/band-engine.md`, session_regime + vol-scalar; tap → next low/high bands). Otherwise the identical `TickerCard` to imported rows (price, danger badge, marker / entry-zone / intraday-stats chips).

### Reading a row — entry temperature, factor flags & the why-sheet (Batch X12)

The leaderboard's job is to answer **"what's a good buy *right now*,"** not just "what's in the pool." Three legible layers, all **FE-derived** from data `useVirtualList` already pulls (no engine/schema work):

- **Entry temperature** — a live verdict recomputed every quote tick from current price vs the walking band (`../signals/band-engine.md`), the live-fire flag, and risk flags (`../signals/risk-flags.md`):
  - 🔥 **hot** — price at/below the band buy level (`current_low_band`) *or* a live dip-bounce fire, **and** no CRITICAL risk flag. A favorable risk:reward dip entry *this moment* (mean-reversion — **not** breakout; breakout is a different, harder signal, roadmapped at `../roadmap.md` → Track 10 → Breakout detection).
  - 🟡 **near** — price in the lower band channel, approaching the buy level.
  - 🧊 **ice / stay away** — a CRITICAL risk flag, or price extended up near `current_high_band` (no dip to buy).
  - (cool — no icon — not a buy now, not dangerous; sits lower.)
  - **Fresh-price honesty:** a stale/seeded off-hours price (`../signals/curated-list.md` → Population & freshness) can populate a row but can never read 🔥 — temperature requires a fresh canonical price, the same gate as `../signals/dip-bounce-scorer.md` → Fresh-price firing gate.

- **Factor flags** — a 🟢 *N tailwinds* / 🔴 *M headwinds* count rolling up every for/against signal on the row: tailwinds (qualifying reason chip(s), price in the buy band, bullish news `../signals/news-signal.md`, good rolling hit-rate, mean-reversion regime, a live fire) vs. headwinds (each active risk flag, bearish news, low hit-rate, price extended vs band, bearish-trend regime). The **badge is the count; the why-sheet itemizes them.** The taxonomy is FE-side presentation (tunable), not a server engine.

- **The "why" sheet** — a one-tap **ⓘ** per row opens a sheet that leads with the temperature verdict in plain language with this row's values ("🔥 Hot — $4.18 at buy band $4.16 · mean-reversion · vol 1.5×" / "🧊 Stay away — CRITICAL: pump risk"), then lists the 🟢 tailwinds and 🔴 headwinds, then rank context (#k of N + the biggest rank driver). It **replaces the hover-only chip `title` tooltips** — dead on a touch phone — and folds the Glossary's definitions inline against live values. The static Glossary (`?`-icon) stays as the general reference; this is the contextual per-row one.

**Sort & surfacing.** Rows sort by **temperature tier first** (🔥 → 🟡 → cool → 🧊), the composite score (above) as the within-tier tiebreaker — best buys-right-now lead. A default-on **"🔥 hot & near only"** filter keeps the screen to actionable rows; when nothing qualifies it shows an honest *"no hot setups right now — N cooling"* state (never a blank that reads as broken), and a toggle reveals the full ranked list.

**Affordances:** long-press → **Add to one of my watchlists** (writes a `watchlist_items` row) or **Set marker** (prefilled at the band p50). Same sheet pattern as imported rows. Long-press **the ticker symbol** specifically → open Robinhood (`_design-system.md` → Long-press the ticker symbol → Robinhood) — scoped to the symbol so it doesn't collide with the row's add-marker long-press.

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

## Engine coverage — visibility opts a list in

Making an imported list **active/visible** opts its tickers into the **full engine**: risk flags, entry-zones, the intraday-stats band, markers — and (compute-set widened with the dip-bounce track) the walking band + dip-bounce score too. Cost is bounded because you don't make every imported list visible; the active set is the lever. Compute set = `curated ∪ active-watchlist ∪ held` (`../signals/curated-list.md` → Consumers).

The one honest limit is **data quality, not compute**: a thin / illiquid imported name may be visible but lack enough intraday-stats history (or liquidity) for a meaningful band or dip-bounce score. Those rows show an explicit *"needs more history"* state rather than a fabricated band — we computed it, the data isn't there yet. Curated (Upside-list) names never hit this — they're pre-filtered for liquidity + ATR.

## Held + watchlisted tickers

A ticker that appears in both Portfolio (held) and a watchlist renders in both surfaces — held variant on the Portfolio card, watchlist variant on the Watchlist row. A name can also sit on a virtual list *and* an imported list (or be held) — same `TickerCard`, same underlying data, one row per surface. Both surfaces query the same canonical quote and `signals` table.
