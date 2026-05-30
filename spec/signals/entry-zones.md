# Dynamic Entry-Zone Engine

Continuous, LLM-free engine that computes recommended entry prices per ticker, recomputed on every poll cycle. Adapts to trend regime; "forgives" overbought tickers by pulling the entry toward current price. Watchlist surface companion to user-authored `markers.md`. Batch A+ scope.

## Concept

Not a one-shot suggestion — a **function recomputed on every poll write** for active watchlist conids:

```
computeEntryZones(currentPrice, dailyBars, intradayBars, indicators, trendRegime)
  → { intraday:  { price, reasoning, confidence },
      overnight: { price, reasoning, confidence },
      multiday:  { price, reasoning, confidence } }
```

Each horizon picks the highest-confluence support level satisfying:
- **Below current price** (it's an entry, not a stop).
- **Reachable within `k·ATR`** for the horizon (k ≈ 1·ATR intraday, 2·ATR overnight, 4·ATR multiday).
- **Adjusted by trend regime**:
  - **Up** → tighten / raise toward the closest viable support; don't insist on a deep level that won't print.
  - **Mixed / range** → range-low / lower Bollinger.
  - **Down** → patient; deeper levels allowed, confidence lower.
- **"Forgiveness" for overbought** (RSI > 70 OR price > SMA50 + 2·ATR): expand the reachable cap so the entry slides toward current price rather than waiting for a pullback that may never come. Surfaces honestly: `"overbought_tightened"`.

Continuous update falls out for free: the function runs on every poll write (10s–5min). Realtime pushes the zones to the FE.

## Trend regime (v1: simple)

For A+ v1, trend is computed from data we already have:

```
slope20 = sign(SMA20[today] - SMA20[5_bars_ago])
posVsSma50 = sign(currentPrice - SMA50)

trend = (slope20 > 0 && posVsSma50 > 0) ? 'up'
      : (slope20 < 0 && posVsSma50 < 0) ? 'down'
      :                                    'mixed'
```

~5 lines in `technicals.ts`. **The deferred full structure-feature work** (ADX gate, major-low anchoring, RSI divergence, `consolidating` label — see `roadmap.md` → "Structure-feature redesign") is the v2 sharpener. Not a blocker.

## Inputs and where they come from

Per compute call:
- `currentPrice` (scalar) — from the canonical quote (`quotes.canonical_price` post-Track-1, `positions.current_price` MVP-today).
- `dailyBars` (~252 OHLCV) — IB `ibHistory(conid, '1y', '1d')`.
- `intradayBars` (5-min OHLCV) — IB `ibHistory(conid, '1d', '5min')`.
- Indicators (RSI, ATR, SMA20/50/200, Bollinger, pivots, swings, %B) — computed from the bars above. Same code as the playbook feature pack.

The raw inputs are two bar arrays per ticker per compute. Everything else derives.

**IB-honesty:** same as the playbook engine — if IB is off, the engine uses last-cached bars + live Finnhub price, with a "bars stale since HH:MM" indicator. Track 9 (free candle provider) is the durable unblock; 13.3 (always-on IB secondary user) is the other.

## Bar fetch policy

For active-list watchlist conids:
- **Nightly batch** refreshes daily bars (and the trailing intraday bars) for all active-list conids.
- **On-demand** fetch on the first poll cycle after a conid becomes active (or the bar cache is stale beyond ~24h).
- The poller-cycle compute itself reads cached bars + live price — does NOT fetch bars per cycle.

## Alerts (A+, tuned later)

Dynamic zones **fire Discord alerts** when price enters them (not read-only). Same `#upside-dip-buys` channel as user markers for the first cut. Cooldown: 24h anchored on `last_fired_at` per `(conid, horizon)` — i.e. one alert per ticker per horizon per day. Fires when price first enters the zone band within the cooldown window.

Debounce caveat: zones recompute every poll cycle, so the boundary moves. First-cut rule: an "entry" event = current price crosses into the band that was published at the prior poll write. Tune empirically.

## Persistence

`entry_zones` table (Track 1, planned — see `../schema.md`). Keyed by `(conid, horizon)`:

```
{ conid, horizon: 'intraday'|'overnight'|'multiday',
  price, reasoning, confidence,
  trend_regime, overbought_tightened bool,
  last_fired_at, computed_at }
```

One row per `(conid, horizon)`, upserted on each compute. FE subscribes to Realtime.

## FE rendering

On the watchlist ticker row: three small horizon chips (`I: $4.10 · O: $4.05 · M: $3.90`), updating live. Tap a chip → see reasoning + confidence + recent firings. The user can promote a dynamic zone to a manual marker with one tap (locks the current price into a static `markers.md` marker so it doesn't drift with the engine).

## Confluence detection

When multiple level methods (e.g. SMA20 + Pivot S1 + recent swing low) cluster within 0.5·ATR, the engine flags `confluence: ['sma20', 'pivot_s1', 'swing_low_recent']` on that zone and bumps confidence. Confluence is the strongest signal — surface it prominently.

## Candidate levels — what's NOT in the pool

Round-number magnets (e.g. "the next round dollar / half-dollar below") are
**excluded** from the candidate set. The first live test (2026-05-29) showed
them generating zones *above* current price for some tickers — i.e. "buy
below $X" where current was already below $X, which reads as "buy market
right now." That's a real money-on-the-table risk and the round-number prior
isn't worth it. Removed from `computeEntryZones`'s candidate collector;
fixtures updated. If round magnets come back, they need a guard that drops
any candidate above current price *before* horizon adjustment, plus a test
fixture that asserts the guard.

## Test suite (mandatory)

The engine has unit tests as part of its definition. See `roadmap.md` → "Entry-engine test suite" for the 10 scenario fixtures (trending up, overbought-forgiveness, consolidation, downtrend, basing/higher-low-off-bottom, gap-up, low-vol, high-vol, confluence, edge cases). Lands with vitest on the server package — `pnpm test:server`.
