# Screener Universe + Trait Scoring

The intraday-scalping screener: scan a large US-stock universe nightly, score
each ticker against a handful of mechanical traits, and surface daily virtual
watchlists ("today's range-traders", "today's catalyst reversals", etc.) the
user picks names from to trade. **No LLM in this engine** — pure technical
math, free data, scoped permissions, reproducible.

Sibling files:
- `band-engine.md` — the three adaptive layers that turn a surfaced ticker's
  intraday-stats row into walking buy/sell bands. Where this file ends, that
  one begins.
- `screens/screener.md` — the FE tab that renders the virtual lists.
- `entry-zones.md` — the per-cycle level engine this generalizes from (same
  shape, the screener runs it across the market instead of the existing
  watchlist).
- `stats.md` — the existing intraday-band math the `intraday_range_trader`
  trait re-uses.
- `markers.md` — user-authored levels, the manual cousin to auto-surfaced
  screener tickers (promote-to-marker is the bridge).

## Why this exists

LLM-driven analysis (Batch 14g playbook) on free-tier models is currently of
poor quality and unprovable without paid API runway. The entry-zone engine
shipped in Batch A+ is free, mechanical, and produces actionable levels —
demonstrated value on the user's existing 25-ticker watchlist. The next step
is to make that engine **search the whole market** for the names worth running
it on, not just the names the user has already picked. The screener is that
search; the band engine is what makes the surfaced names tradeable.

Concretely the user wants the system to surface candidates like REPL (FDA
catalyst reversal, 2026-05-29, 4+ scalp legs in one session) on the day they
become tradeable, not after the move is over.

## Universe

### Ring 0 — symbol pull

Source: Finnhub `/stock/symbol?exchange=US`. As of 2026-05-30 this returns
**30,538 symbols** across all listing venues. Single call, cached for the
day. No rate-limit concern.

### Ring 1 — hard filter

Applied nightly. A symbol enters the screener universe iff:

- `type ∈ {Common Stock, ADR}` — drops ETFs, REITs, units, rights, warrants,
  closed-end funds, OTC garbage. Reduces ~30.5k → ~20.6k.
- `mic ∈ {XNAS, XNYS, XASE}` — NASDAQ + NYSE + NYSE American. Drops OTC,
  ARCX (mostly ETFs), BATS. Reduces ~20.6k → **5,307** as of 2026-05-30.
- `$1 ≤ last price ≤ $100` — user's price ceiling; sub-$10 is preferred but
  not enforced (preference goes into trait scoring, not the hard filter).
- `marketCap ≥ $150M` — floor against pump-and-dump microcaps. No upper cap;
  user accepts that mega-caps will mostly drop out via trait scoring.
- (deferred) Avg daily volume ≥ 1M shares (30d median). Requires per-symbol
  candle fetch; added once the nightly cron amortizes the cost.

**Measured survivor count (`scripts/universe-sample.mjs`, 2026-05-30, 250-symbol random sample):** Wilson 95% CI = **2,728 – 3,373** (point ~3,051). Distribution roughly even across price bands and skewed to small/mid caps. The number's higher than initially hand-waved; volume filter when added is expected to trim further.

### Dynamic universe inclusion

Pre-market sweep (15:30 IDT) checks **overnight news + AH price movement** on
the broader symbol pool — when a ticker outside Ring 1 prints a 3× volume
gap during pre-market, it's **auto-promoted to the universe for the day**.
Catches REPL-on-FDA-day even when its baseline 30d volume was below the
1M-shares floor. No mid-day broad-pool discovery in v1 — see `roadmap.md` →
Screener deferred items.

## Traits

Each trait is a pure-function rule over the existing computed feature pack
(pivots, swing H/L, ATR, SMA/EMA, RSI, Bollinger, VWAP — see
`server/src/services/technicals.ts`) plus the new `intraday_stats` row.
Scored per `(conid, asof_date)`, stored on `trait_scores` (see `../schema.md`).
Higher score = better fit. Each trait independent; a ticker can score in
multiple traits.

### `intraday_range_trader`

The flagship trait for the scalping vision. Surfaces stocks where typical
intraday behavior matches the user's pattern (REPL/MNTS/RGTI: predictable
dip + predictable recovery within session, multiple times).

Rule (combined into a single 0–100 score):

- `intraday_stats.intraday_low_pct.p50 ≥ 2.0%` (deep enough dip to scalp)
- `intraday_stats.intraday_low_pct.p25 ≥ 1.0%` (consistently dips, not just outlier days)
- `intraday_stats.sample_size ≥ 30` (enough sessions for stats to be meaningful)
- `(p75 − p25) / p50 ≤ 1.5` (narrow envelope → predictable behavior)
- Bonus: lower price (sub-$30 strongest, sub-$10 boost)

Payload: `{ p25, p50, p75, sample_size, today_open_band_low }` — ready-to-render
on the FE row chip.

### `catalyst_reversal`

REPL-on-FDA-day. Mechanical volume-gap detection, no news API needed.

Rule — A ∧ B both must hold:

- **A (beaten down)** — any of:
  - `price < SMA(200)` (sustained downtrend), OR
  - `% off 52w high > 30%`, OR
  - `RSI(14)` hit `< 30` within last 30 sessions
- **B (sudden wake-up)** — both:
  - `today_volume > 3 × median(volume, 30d)` (the gap)
  - `|today_intraday_move %| > 5%` OR `|today_open_gap %| > 5%`

Score: composite of (gap multiplier × intraday-move magnitude × beaten-down
depth). Shelf life 1–3 days from `last_fired_at`; trait drops off automatically.

### `post_earnings_drift`

Post-earnings positive drift: stocks that reported in the last 1–3 trading
days AND closed up ≥2% on the report day tend to drift in the same direction
for several sessions.

Rule:
- Finnhub `/calendar/earnings` shows earnings released ≤ 3 trading days ago
- Report-day close was ≥ +2% above prior close

Score: combination of report-day pop magnitude + days-since-earnings (earlier
= stronger). Shelf life: 5 trading days from report.

## Sweep cron schedule (IDT)

See `../flows.md` → Screener Universe Sweep Flow + Pre-Market Refresh Flow for
the procedural detail.

| time (IDT) | what runs |
| --- | --- |
| **09:00** | Nightly universe sweep — Ring 1 filter against full pool, refresh `universe` rows. Trait scoring on universe survivors. Materializes curated lists for the user's morning. |
| **15:30** | Pre-market refresh — overnight news + AH-price-move check; dynamic universe inclusion fires here. Trait scores refreshed. |
| **15:45** | Session_regime classifier fires per curated-list ticker (`band-engine.md` Layer 1). |
| **16:30–23:00** | Curated-list intraday refresh, 30-min cadence (5-min on `band-engine.md` Layer 3 inside the band engine). |
| **23:00–03:00** | After-hours band walking with low-confidence annotation. |
| **next 16:30** | Bands reset cleanly at next regular open. |

## Discord ping policy (screener-related)

Trait-first-fire and curated-list joins ping. Ongoing trait presence does not.

- `catalyst_reversal` trait fires for a new ticker → `#upside-catalyst-alerts`
  (new channel). One alert per ticker per day.
- `post_earnings_drift` trait first surfaces a ticker → same channel.
- `intraday_range_trader` trait surfacing is **silent** — these stocks are
  the *baseline* of the screener; pinging them all daily would be noise. The
  band-touch pings (see `band-engine.md` Discord policy) carry the actionable
  events for these names.

Cooldown: 24h per `(conid, trait)`.

## Out of scope for this engine

- The walking band math itself → see `band-engine.md`.
- The Screener FE tab layout → see `screens/screener.md`.
- The new tables (`universe`, `trait_scores`) → see `schema.md`.
- The cron procedural flows → see `flows.md`.
- Deferred items (RSS firehose, mid-day broad-pool discovery, IBKR push of
  curated lists, sell-side mirror) → see `roadmap.md` → Screener deferred items.
