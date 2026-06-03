# Adaptive Band Engine

Turns a ticker's nightly `intraday_stats` row into **walking intraday buy/sell
bands** that adapt to today's gap, today's realized volatility, and the day's
unfolding pivots. Three composable layers stacked on top of the static
statistical band from `stats.md`.

Used by the screener's curated lists (`screener-universe.md`) and by held
positions in Portfolio (sell-side bands on owned tickers). The engine doesn't
care whether a ticker is "held" or "watched" — the same band math runs; the
direction the user cares about (buy band for unowned, sell band for owned)
differs at the consumer.

Sibling files: `stats.md` (the static baseline that this consumes),
`screener-universe.md` (the trait scoring that feeds the curated list),
`screens/screener.md` (the FE surface), `../schema.md` → `band_state` table
(the persistence layer).

## Why three layers

The static `intraday_stats` p50 band — `today_open × (1 − p50_intraday_low_pct)` —
is correct on stocks with stable character but wrong on:

- **Trend days** — gap-up rip-from-open never dips below open, so the
  predicted low band never fills.
- **Vol-regime-shift stocks** — post-catalyst REPL with realized ATR 2× its
  60d baseline fades wider than 60d aggregate predicts. Static p50
  understates. **Validated empirically 2026-05-30**: MNTS realized 16.67%
  fade vs 60d p50 of 6.46% — user's three buys all fell outside the static
  p25–p75 envelope. RGTI on the same day was inside the envelope. Same
  engine, different correctness, same root cause.
- **Multi-leg scalping** — user's REPL pattern (4+ buy/sell legs in one
  session, walking up the day) — a single static band frozen at open
  describes only the first leg. Subsequent legs need bands re-anchored at
  the new local pivots.

Three layers fix all three:

1. **Session regime classifier** — tells the user what kind of day this is so
   bands are interpreted with the right confidence.
2. **Today's vol scalar** — widens/tightens bands in real time based on
   today's realized volatility vs baseline.
3. **Walking band-state machine** — re-anchors bands on observed reversal
   from running local extrema, publishing forward-looking next-leg targets.

## Layer 1 — Session regime classifier

Publishes a single label at **16:45 IDT** (15 min after regular open at
16:30 IDT). One classification per ticker per day; held until 16:30 IDT
next session.

| label | when fired |
| --- | --- |
| `mean_reversion` | flat-ish gap (|gap| < 2%), chop in first 15 min, normal pre-mkt volume — bands trustworthy as-is |
| `bullish_trend` | gap up ≥ 2% AND first 15 min up — predicted-low band may not fill; high band fills early then keeps going past it |
| `bearish_trend` | gap down ≥ 2% AND first 15 min down — predicted-low fills then keeps falling; high band may not fill |
| `mixed` | conflicting signals — bands lower confidence |

Inputs for the classifier:
- **Pre-market gap**: today's open vs prior regular-session close, signed %.
- **First-15-min direction**: close at `regular_open + 15min` vs `regular_open`.
- **Pre-market volume vs 30d pre-market median**.
- (later, when RSS lands) catalyst/earnings flag — see `roadmap.md`.

The label travels on the `band_state` row as `session_regime`. FE renders it
as a small chip on each band-publishing surface; chip color dims when
classification predicts the band won't fill (`bullish_trend` dims the low
band, `bearish_trend` dims the high band).

## Layer 2 — Today's vol scalar

Updates every 5 minutes during regular session. Compensates for the static
60d aggregate when today's realized volatility deviates from baseline.

```
vol_ratio = ATR(last 12 five-min bars) / ATR_30d_baseline

if vol_ratio > 1.5:  band_width *= 1.5, annotate "high vol today"
if vol_ratio < 0.5:  band_width *= 0.7, annotate "calm day"
else:                bands at baseline
```

The 60d data gives the *shape* of fade behavior; today's volatility gives
the *magnitude scalar*. Combined with the walking state machine (Layer 3),
the engine is heavily current-state driven — the 60d baseline is the prior,
today is the evidence.

Stored on `band_state.vol_scalar`. Logged with each tick so back-testing
can see the time evolution.

### Fade-pct + baseline-ATR sourcing (v1 simplification)

The math above assumes two inputs from `intraday_stats` that the current
schema (`stats.md`) does NOT separately carry:

- **`ATR_30d_baseline`** in price space — used as the vol_scalar denominator.
  `intraday_stats` stores `intraday_low_pct_p50` (typical % drawdown) but not
  a 30d ATR in price units. **v1 approximates**:
  `baseline_atr ≈ today_open × intraday_low_pct_p50 / 100`. Captures cross-
  stock variation + order of magnitude (a 6% typical drawdown produces a
  much larger price-space baseline than a 1.5% drawdown), at the cost of
  conflating "session drawdown" with "5-min bar TR." **Track-10 sharpening**:
  add `atr_30d_5min` column to `intraday_stats`; `intradayStatsCron` computes
  it during the nightly bar pull.
- **`p50_high_fade_pct` + `p50_low_fade_pct`** — the typical up-leg and down-
  leg fade sizes used in band publication (`stats.md` only carries the
  intraday-low percentile, no symmetric up-leg fade). **v1 uses
  `intraday_low_pct_p50` for both directions** as a symmetric proxy — the
  typical session drawdown is a fair stand-in for "typical leg size" at the
  population level, but it bakes in the assumption that up-legs and down-
  legs are the same magnitude (often roughly true on mean-reversion days,
  less true on trend days). **Track-10 sharpening**: extend
  `computeIntradayStats` to also bucket per-leg fade %s and store
  `leg_up_fade_pct_p50` + `leg_down_fade_pct_p50` separately.

Sharpening is non-trivial — both items require schema migrations + cron
extensions. The proxies preserve direction + magnitude; the band engine
ships useful in v1 and gets more accurate when these baselines tighten.

### vol_regime_shift flag (slow companion)

A daily-resolution version of the same idea: when the last 5 sessions' ATR
is `> 2× prior 30d ATR`, the stock has just stepped into a new vol regime
(post-catalyst REPL is the canonical case). The static `intraday_stats` row
is too slow to reflect this. Set `band_state.vol_regime_shift = true` for
the day and annotate the bands with "vol regime shift — bands lower
confidence." This is the cheap correctness hedge — no auto-truncation of
the lookback yet (that's a v2 sharpening, see `roadmap.md`).

## Layer 3 — Walking band-state machine

The bands walk with intraday structure instead of being frozen at open.

### State

Stored on `band_state` (see `../schema.md`):

- `anchor_low` — the most recent local-low pivot (last re-anchor low)
- `anchor_high` — the most recent local-high pivot (last re-anchor high)
- `running_max_since_low_anchor` — tracks running max since last low anchor
- `running_min_since_high_anchor` — tracks running min since last high anchor
- `leg_direction` — `'up' | 'down' | null`. Null at seed; set on the first
  reversal that crosses threshold; flips on each subsequent anchor.
  Required to prevent the same-side anchor from re-firing as price keeps
  moving past it: after a low-anchor we're on an upward leg and only high-
  anchors fire; after a high-anchor, the reverse. The conditional phrasing
  below ("If tracking an upward leg from anchor_low") makes this implicit;
  v1 implementation makes it an explicit state field on `band_state`.
- `anchors jsonb` — chronological array of `{kind, price, ts}` for replay/debug

### Initial seed

At 16:30 IDT (regular open): `anchor_low = anchor_high = today_open`,
running extrema = `today_open`, no published bands yet (waits for first
re-anchor). The first leg's direction is determined by the first reversal
event.

### Re-anchor trigger

The critical mechanic — **triggers on observed reversal from a running
extremum, NOT on touching our predicted band**:

```
reversal_threshold = 0.5 × ATR(last 12 five-min bars)   // self-scaling to today

If currently tracking an upward leg from anchor_low:
  running_max := max(running_max, current_price)
  if (running_max − current_price) ≥ reversal_threshold:
    anchor_high := running_max
    running_min := current_price
    publish bands  (next-leg low + the after-that high)

Symmetric for downward leg from anchor_high.
```

Why "observed reversal" not "predicted-band touch": if we waited for price
to hit our predicted high before re-anchoring, a leg that reverses early
(common — predicted high was a guess) would never trigger a re-anchor and
the user would stay positioned for a level that never comes. **Reality
leads, prediction informs.** The predicted band remains in the published
output as an *informational target* ("if this leg behaves typically, here's
where it tops"), not a trigger condition.

### Band publication on re-anchor

Both bands recompute on every anchor — user wants forward visibility on the
next few moves, not just the immediate next leg.

```
After a low-anchor at price L:
  next_high_band = L × (1 + p50_high_fade_pct × vol_scalar)
  next_low_band  = next_high_band × (1 − p50_low_fade_pct × vol_scalar)
    (forward planning — where the leg AFTER the next high would land)

After a high-anchor at price H:
  next_low_band  = H × (1 − p50_low_fade_pct × vol_scalar)
  next_high_band = next_low_band × (1 + p50_high_fade_pct × vol_scalar)
```

`p50_high_fade_pct` and `p50_low_fade_pct` come from the static
`intraday_stats` row (`stats.md`); `vol_scalar` from Layer 2. The
session_regime label from Layer 1 dims/highlights the band on the FE side.

### No chain-length limit

Regime mixing (price walking back-and-forth, re-anchoring many times) is the
normal state of charts, not a degenerate case. The state machine walks freely
all session. If the bands become useless because real movement diverges, the
user notices that from the data — no artificial cap needed.

## Reset rules

- **16:30 IDT regular open** — clean reset: `anchor_low = anchor_high =
  today_open`, anchors cleared, session_regime cleared (will re-fire at
  15:45). No AH carryover.
- **After-hours (23:00–03:00 IDT)** — bands continue walking with the
  Layer-1 label marked `ah_low_confidence`. Re-anchors still fire but the
  user's FE chip warns the data is noisier. Resets at next 16:30 IDT.

## Discord ping policy (band-touch events)

Pings = **actionable price targets**. Engine state changes don't ping.

- Band touch on **non-held curated ticker** (predicted low reached) →
  `#upside-dip-buys` (the existing channel — same audience as marker hits).
- Band touch on **held position** (predicted high reached on a position the
  user owns) → `#upside-sell-zones` (new channel).
- Cooldown: 4h per `(conid, band_kind)` — chop session doesn't fire 8 times
  for the same level.

Does NOT ping:
- Re-anchor events (silent — only band-touches alert)
- session_regime label changes (passive context)
- vol_scalar transitions (passive)
- New band publication at each tick (the publication is the FE data feed,
  not a notification)

See `../flows.md` → Band Walk Flow + Band-Touch Notification Flow for the
sequenced detail.

## What this engine doesn't do

- It doesn't propose markers automatically (the user-controlled markers in
  `markers.md` stay as the only auto-created watchlist-marker rows; band
  touches notify but don't write markers). Auto-marker creation is a
  potential roadmap item — see `roadmap.md` → Screener deferred items.
- It doesn't drive curated-list membership — see `curated-list.md` for the
  rule (top-N by `intraday_range_trader` + liquidity + ATR floor, ~200-300
  names). The band engine reads the list; it doesn't decide it.
- It doesn't run for *every* universe ticker — only the curated list
  (~200-300 names) gets the Layer-3 walking. Layer 1+2 + static bands can
  run more broadly if needed but the user-facing live publication is
  curated-only.
