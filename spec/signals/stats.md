# Intraday Stats Engine

LLM-free per-symbol statistics computed nightly from historical 5-min bars.
Surfaces "what does this stock typically do intraday" — used both as **context**
on TickerDetail and as a **trigger** for Discord alerts when today's drop from
open enters the typical-intraday-low band. Batch B scope. Sibling files:
`markers.md` (user-authored levels), `entry-zones.md` (continuous per-cycle
level engine), `zone.md` (P&L-threshold alerts on held positions).

## Concept

Three stats per symbol, each as **mean + p50 + an "extreme" percentile**:

| stat                 | what it is                                  | extreme |
| -------------------- | ------------------------------------------- | ------- |
| `open_fade_pct`      | % move in the first ~30 min after open      | p25 (soft fade) |
| `close_fade_pct`     | % move in the last ~30 min into close       | p25 (soft fade) |
| `intraday_low_pct`   | % drop from open to that day's low (always positive — bigger = deeper) | p75 (deep dip) |

Stored on `intraday_stats` (one row per `conid`) — see `../schema.md`. Each row
also carries `sample_size`, `lookback_days`, `computed_at`, and `last_fired_at`
(24h alert cooldown). Symbol mirrored on the row + indexed so TickerDetail can
query by symbol without joining contracts.

Why three percentiles, not one: the FE renders a **band**, not a point. The
alert engine picks its trigger from the same row without recompute. The mean is
useful as a sanity check against the median (right-tailed distributions warn
the user about outlier days the median hides).

## Lookback

**60 trading days** default — responsive enough to reflect the stock's current
character, broad enough to be statistically meaningful. Configurable per row in
schema so future tuning is per-symbol if needed. The user's framing for picking
60 days was that they want *both* intraday and multi-day deals; 60d is the
intersection of "recent enough to reflect now" and "deep enough that a couple of
outlier sessions don't dominate."

## Compute

`computeIntradayStats({ bars, lookbackDays?, fadeBars? })` — pure function in
`server/src/services/intradayStats.ts`. Groups 5-min bars by ET session,
computes the three stats per session, then summarizes across sessions.

- `lookbackDays` default 60.
- `fadeBars` default 6 (6 × 5-min = first/last 30 min).
- Sessions with < `fadeBars` bars are dropped.
- Percentiles use linear interpolation (the standard library helper).

Has its own vitest fixtures (5 scenarios: typical fade, no-fade, lookback
respect, empty input, p75-deeper-than-p50). `pnpm test:server`.

## Cron

`server/src/cron/intradayStatsCron.ts` — **24h cadence, IB-gated.** Iterates
distinct active-list conids; per conid: `ibHistory(conid, '2m', '5mins')` →
`computeIntradayStats` → upsert. First run 5 minutes after boot. IB-only
(Finnhub's free `/stock/candle` is intraday-deficient).

If IB is off when the cron fires, the run is a no-op — stats stay at the prior
day's snapshot. Honest staleness is preferable to imputed values; the FE shows
`computed_at` so the user sees how fresh the row is.

## Alert (typical-low band entry)

`checkIntradayStatsForConid(conid, symbol, prev, curr)` runs from
`upsertQuote` on every canonical price write (alongside marker + entry-zone
checks).

Band in price space:

```
band_top    = today_open × (1 − p50/100)   ← typical intraday-low
band_bottom = today_open × (1 − p75/100)   ← "deep" intraday-low
```

(p50 / p75 are positive percentages — drops below open. `band_top > band_bottom`
since the band lives below open.)

**Fire** when `prev > band_top AND curr ≤ band_top` (cross-into-band). Subsequent
moves deeper into the band do NOT re-fire — the user already has the chip + the
Discord ping. **Cooldown** 24h anchored on `intraday_stats.last_fired_at`.

Requires `quotes.today_open` to be populated for the conid; if it's missing the
check returns silently (band can't be computed). All three pollers thread
`today_open` into `upsertQuote` (IB snapshot field 7295 / Finnhub `quote.o`).

### Discord channel

`#upside-stats-alerts` (env `DISCORD_WEBHOOK_STATS_ALERTS`) — separate from
`#upside-dip-buys` so the user can tune attention per source. Message format:

```
🔵 SYMBOL entered typical intraday-low band — $4.18
    Today: -2.1% below open ($4.27)
    Band: $4.16–$4.10 · typical -2.5% / deep -4.0%
    [link to TickerDetail]
```

(blue embed for visual distinction from dip-buys' green and zone-profit's
amber.)

## FE rendering

**Watchlist row — `IntradayStatsChip`** (`components/Watchlist/IntradayStatsChip.tsx`):
tiny chip in the right-side cluster (after the marker + entry-zone cluster)
showing today's drop vs. the band. Three color states:

- `above` (dim): `dropPct < p50` — normal intraday noise.
- `typical` (event accent): `p50 ≤ dropPct < p75` — at typical-low.
- `deep` (buy accent, bold): `dropPct ≥ p75` — deeper than typical.

Hidden entirely when no stats row OR no `today_open` — em-dashes would just add
noise. Tooltip shows the full math + lookback metadata.

**TickerDetail — `IntradayStatsPanel`** (`components/TickerDetail/IntradayStatsPanel.tsx`):
new collapsible section "Intraday stats" rendering all three stats × three
columns (Mean / Typical p50 / Extreme p25-or-p75). Footnote shows
`<lookback>d lookback · n=<sample_size> sessions · computed <ts>` so the user
can judge freshness. Empty state explicitly mentions the nightly-cron cadence
rather than rendering em-dashes for every cell.

Data wiring: `useWatchlistData` adds a `statsByConid` map + an `intraday_stats`
Realtime subscription. `useIntradayStats(symbol)` is a single-symbol hook for
TickerDetail (keys by `symbol` since `TickerDetailData` carries symbol but not
conid — `intraday_stats.symbol` is indexed in migration 017 for this reason).

## Migrations

- `017_intraday_stats.sql` — the table + the symbol index + realtime publication.
- `018_quotes_today_open.sql` — `quotes.today_open numeric` (required by the
  alert engine to compute the band; orthogonal to the stats row itself).
