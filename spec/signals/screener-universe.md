# Screener Universe + Adaptive Band Engine

The intraday-scalping screener: scan a large US-stock universe nightly, score
each ticker against a handful of mechanical traits, and surface daily virtual
watchlists ("today's range-traders", "today's catalyst reversals", etc.) the
user picks names from to trade. **No LLM in this engine** — pure technical
math, free data, scoped permission, reproducible. Sibling files:
`entry-zones.md` (the per-cycle level engine this generalizes from),
`stats.md` (the existing intraday-band math this re-uses),
`markers.md` (user-authored levels — the manual cousin),
`playbook.md` (the LLM-driven analysis path — deliberately disjoint).

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
30,538 symbols across all listing venues. No call quota required to refresh
this list (single call, cached).

### Ring 1 — hard filter

Applied nightly. A symbol enters the screener universe iff:

- `type ∈ {Common Stock, ADR}` — drops ETFs, REITs, units, rights, warrants,
  closed-end funds, OTC garbage. Reduces ~30.5k → ~20.6k.
- `mic ∈ {XNAS, XNYS, XASE}` — NASDAQ + NYSE + NYSE American. Drops OOTC,
  ARCX (mostly ETFs), BATS. Reduces ~20.6k → **5,307** as of 2026-05-30.
- `$1 ≤ last price ≤ $100` — user's price ceiling; sub-$10 is preferred but
  not enforced (preference goes into trait scoring, not the hard filter).
- `marketCap ≥ $150M` — floor against pump-and-dump microcaps. No upper cap;
  user accepts that mega-caps will mostly drop out via the trait filters
  rather than the universe filter.
- (deferred) Avg daily volume ≥ 1M shares (30d median). Requires per-symbol
  candle fetch; added once nightly cron runs and we can amortize the cost.

The Ring 1 survivor count from `scripts/universe-sample.mjs` (250-symbol
random sample) goes here once measured. Expectation: ~1,200–2,500 survivors
out of the 5,307 type+MIC pool, point-estimated via Wilson 95% CI.

### Dynamic universe inclusion

Pre-market sweep (15:30 IDT) checks **overnight news + AH price movement** on
the universe pool — when a ticker outside Ring 1 prints a 3× volume gap during
pre-market, it's auto-promoted to the universe for the day. This catches
REPL-on-FDA-day even when its baseline 30d volume was below the 1M floor. **No
mid-day discovery sweep against the broader ~10k symbol pool in v1** — empirical
monitoring decides whether to add later.

## Traits

Each trait is a pure-function rule over the existing computed feature pack
(pivots, swing H/L, ATR, SMA/EMA, RSI, Bollinger, VWAP — see
`server/src/services/technicals.ts`) plus the new `intraday_stats` row.
Scored per `(conid, asof_date)`, stored on `trait_scores`. Higher score = better
fit. Each trait independent; a ticker can score in multiple traits.

### `intraday_range_trader`

The flagship trait for the scalping vision. Surfaces stocks where typical
intraday behavior matches the user's pattern (REPL/MNTS/RGTI: predictable
dip + predictable recovery within session, multiple times).

Rule (combined into a single 0–100 score):

- `intraday_stats.intraday_low_pct.p50 ≥ 2.0%` (deep enough dip to scalp)
- `intraday_stats.intraday_low_pct.p25 ≥ 1.0%` (consistently dips, not just outlier days)
- `intraday_stats.sample_size ≥ 30` (enough sessions for stats to be meaningful)
- `(p75 - p25) / p50 ≤ 1.5` (narrow envelope → predictable behavior)
- Bonus: lower price (cheaper stocks get a scoring bump, ≤$30 strongest)

Output payload: `{ p25, p50, p75, sample_size, today_open_band_low }` —
ready-to-render on the FE row chip.

### `catalyst_reversal`

REPL-on-FDA-day. Mechanical volume-gap detection, no news API needed.

Rule (A ∧ B both must hold):

- **A (beaten down)** — any of:
  - `price < SMA(200)` (sustained downtrend)
  - `% off 52w high > 30%`
  - `RSI(14)` hit `< 30` within last 30 sessions
- **B (sudden wake-up)** — both:
  - `today_volume > 3 × median(volume, 30d)` (the gap)
  - `|today_intraday_move%| > 5%` OR `|today_open_gap%| > 5%`

Score = composite of (gap multiplier × intraday-move magnitude × beaten-down
depth). Shelf life 1–3 days from `last_fired_at`; trait drops off automatically.

### `post_earnings_drift`

Post-earnings positive drift: stocks that reported earnings in the last 1–3
trading days AND closed up ≥2% on the report day tend to drift in the same
direction for several sessions.

Rule:

- Finnhub `/calendar/earnings` shows earnings released ≤ 3 trading days ago
- Report-day close was ≥ +2% above prior close

Score: combination of report-day pop magnitude + days-since-earnings (earlier
= stronger). Shelf life: 5 trading days from report.

## The band engine — three adaptive layers

The static intraday-stats band (`open × (1 - p50_fade)`) is the **baseline**.
Three layers adapt it to today's reality.

### Layer 1 — session_regime classifier (fires at 15:45 IDT)

By the time the regular session has been open for 15 minutes, gap + opening
drive + pre-market volume give enough signal to classify the day. The
classifier publishes one label, attached to each curated ticker for the day:

| label              | when                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `mean_reversion`   | flat-ish gap (|gap| < 2%), chop in first 15min, normal pre-mkt vol — bands trustworthy |
| `bullish_trend`    | gap up ≥ 2% AND first 15min up — predicted-low band may not fill; high band fills early then keeps going |
| `bearish_trend`    | gap down ≥ 2% AND first 15min down — predicted-low fills then keeps falling; high band may not fill |
| `mixed`            | conflicting signals — bands lower confidence                       |

Bands render with the classifier label as a chip. On `bullish_trend` /
`bearish_trend`, the band confidence chip is dimmed to communicate "today is
not a typical mean-reversion day."

### Layer 2 — today's vol scalar (updates every 5 min during session)

The 60d historical fade % is calibrated to the stock's normal volatility. Post-
catalyst REPL with ATR 2× baseline will fade wider than its history says.
Compensate by scaling:

```
vol_ratio = ATR(last 12 five-min bars) / ATR_30d_baseline

if vol_ratio > 1.5: band_width *= ~1.5, annotate "high vol today"
if vol_ratio < 0.5: band_width *= ~0.7, annotate "calm day"
else:                bands at baseline
```

The 60d data gives the *shape* of fade behavior; today's volatility gives the
*magnitude scalar*. With this + the walking state machine + the regime
classifier, the engine is heavily current-state driven — the 60d baseline is
the prior, today is the evidence.

### Layer 3 — walking band-state machine (5-min ticks)

Bands walk with the intraday structure instead of being frozen at open. State:

- `anchor_low` — the most recent local-low pivot (= last re-anchor low)
- `anchor_high` — the most recent local-high pivot (= last re-anchor high)
- `running_max_since_low_anchor` — tracks running max since last low anchor
- `running_min_since_high_anchor` — tracks running min since last high anchor

Re-anchor trigger (the key insight from design discussion):

```
reversal_threshold = 0.5 × ATR(last 12 five-min bars)

If we were tracking up from anchor_low:
  If current price has reversed ≥ reversal_threshold from running_max:
    anchor_high := running_max (re-anchored)
    publish: new predicted-low band = anchor_high × (1 - p50_low_fade_pct × today_vol_scalar)
            new predicted-high band = anchor_low × (1 + p50_high_fade_pct × today_vol_scalar)  [forward look]

Symmetric for downward leg.
```

Critical: the re-anchor triggers on **observed reversal from running extremum**,
not on touching our predicted band. The predicted band is informational; the
running extremum is the trigger source. This means a leg that reverses *before*
hitting our predicted high still triggers re-anchor, so the user is warned to
exit before being trapped.

Both bands recompute on every anchor (next leg primary, leg-after-that secondary
for forward planning). No chain-length limit — regime mixing is normal chart
behavior, not a degenerate case.

The `vol_regime_shift` flag annotates the bands as low-confidence when the
last 5 sessions' ATR is > 2× the prior 30 days — honest about uncertainty when
the stock has just stepped into a new vol regime.

## Schema sketch

Three new tables, described not implemented:

### `universe`

One row per ticker that has ever entered the universe. Updated nightly.

- `conid bigint PK`
- `symbol text`
- `type text` — Finnhub type field (`Common Stock` / `ADR`)
- `mic text` — exchange identifier (`XNAS` / `XNYS` / `XASE`)
- `last_filter_pass timestamptz` — last time Ring 1 passed
- `filter_result text` — `'in' | 'out_price' | 'out_cap' | 'out_volume' | 'no_data'`
- `last_price numeric`, `last_market_cap_m numeric`, `last_avg_volume integer` — cached for diagnosis
- `computed_at timestamptz`

### `trait_scores`

One row per `(conid, trait, asof_date)`. Re-written on each daily/intraday
sweep. Stale rows beyond shelf-life dropped by retention cron.

- `conid bigint`
- `trait text` — `'intraday_range_trader' | 'catalyst_reversal' | 'post_earnings_drift'`
- `asof_date date`
- `score numeric` — 0–100
- `payload jsonb` — trait-specific details for FE rendering (band values, gap %, days-since-earnings)
- `computed_at timestamptz`
- `PRIMARY KEY (conid, trait, asof_date)`

### `band_state`

One row per `(conid, session_date)`. Walking state machine's persistence layer.

- `conid bigint`
- `session_date date`
- `anchors jsonb` — array of `{ kind: 'low'|'high', price, ts }` in chronological order
- `current_low_band numeric`, `current_high_band numeric`
- `session_regime text` — `mean_reversion | bullish_trend | bearish_trend | mixed`
- `vol_scalar numeric` — today_ATR / baseline_ATR
- `vol_regime_shift boolean` — last-5-sessions ATR vs prior 30d
- `updated_at timestamptz`
- `PRIMARY KEY (conid, session_date)`

## Cron schedule (IDT)

| time (IDT) | what runs |
| ---------- | --------- |
| **09:00** | Nightly universe sweep — Ring 1 filter against full pool, refresh `universe` rows. Trait scoring on universe survivors (intraday_range_trader needs `intraday_stats`; catalyst_reversal needs prior-day candles; post_earnings_drift needs earnings calendar). Materialize curated lists for the user's morning. |
| **15:30** | Pre-market refresh — re-check overnight news + AH price moves on universe. Dynamic universe inclusion (volume-gap promotion). Refresh trait scores. |
| **15:45** | Session regime classifier fires for each curated-list ticker. |
| **16:30** | Regular session opens. Band-state machine seeded from session open. |
| **16:30–23:00** | Band state machine walking every 5 min on curated list (~100 conids). 5-min cadence drives the Layer 2 vol scalar refresh and Layer 3 re-anchor checks. |
| **23:00–03:00** | After-hours band walking continues with `low_confidence` annotation. Re-anchors fire but at lower trust. |
| **16:30 next day** | Bands reset cleanly at next regular session open. No carryover from AH. |

## Discord ping policy

Pings = **actionable price targets only**. Engine state changes don't ping.

Fires:

- Band touch (price reaches predicted low or high band) → `#upside-dip-buys` or new `#upside-sell-zones` for sell-side
- Sell-zone hit on **held positions** (predicted high band reached on a position the user owns) → `#upside-sell-zones`
- catalyst_reversal trait first fires for a new ticker → `#upside-catalyst-alerts` (new channel, one alert per ticker per day)
- post_earnings_drift trait first surfaces a ticker → same channel

Does NOT fire (deliberately silent):

- Re-anchor events (the band recompute is silent; only band-touches alert)
- session_regime label changes (passive context, not action)
- New trait_scores rows being written nightly
- Universe gaining/losing members (the screener tab shows this; no ping)

Cooldowns: per `(conid, band_kind)` — 4h cooldown on the same band, so a chop
session doesn't fire 8 times for the same level.

## FE shape

New **Screener tab** in the bottom nav, next to Watchlist. Layout TBD pending
data density — initial proposal: **vertical accordions, one per trait, top-5
default, "Show all 30" to expand**. Renders the trait-score payload directly
(band values, sample names, today's regime label).

Promote-to-watchlist affordance — same pattern as the Batch A+ entry-zone
promote-to-marker action. Tap a ticker row → "Add to my watchlist" + an
optional "Set a marker" sheet.

Animation: `PriceFlicker` component (see `scripts/anim-integration.md`) wraps
price spans across both Watchlist and Screener — color flash + directional
arrow on any change, double-flash on bigger moves (scaled to stock's vol).

## Deferred (with explicit trigger conditions)

| item | revisit when |
| ---- | ------------ |
| RSS catalyst-news firehose (SEC EDGAR + FDA + PR wires + keyword polarity scoring, no LLM) | After `catalyst_reversal` has shipped + ≥1 missed-move where RSS would have caught the catalyst first |
| Mid-day broad-pool discovery sweep (~10k symbols mid-session) | After observed empirical misses of intraday-catalyst events (rare: midday FDA, surprise halts) |
| Sell-side mirror engine (`typical_intraday_high`) | Slice 2 — buys the user the sell band for held positions; trivial extension once buy-side stable |
| AH-calibrated bands (pre-market + AH bar engine separately tuned) | If AH activity proves a meaningful fraction of user's trading |
| IBKR-side watchlist push (Slice 4) | After Batch 13.3 (secondary IBKR user) unblocks, AND user has used a curated list for ≥1 week and identified one worth elevating to IB |

## Out of scope for slice 1

- IBKR push of virtual lists into IB Mobile watchlists (Batch 13.3 dependency)
- Screener tab final layout (data-driven decision after we've seen the trait
  output density)
- Per-trait cooldown UI in FE (the engine has the field; the FE control comes
  later)
- Auto-promote-to-marker from screener output (manual promote is enough for v1)
