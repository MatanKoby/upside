# Curated List

Auto-maintained pool of ~200-300 "high-potential dip-bounce" names. Decides
membership of the alert pool that `dip-bounce-scorer.md` fires on and the
walking-band pool that `band-engine.md` runs Layer 3 against. Also the
character-pool source for the Intraday / Swing virtual lists
(`../screens/watchlist.md` → Upside-curated virtual lists; reshaped from the
retired Screener tab with Batch X2).

Sibling files:
- `screener-universe.md` — Ring-1 filter (~3,000 names) that this curates
  from + trait scoring that feeds membership.
- `band-engine.md` — consumes the list as its walking-band input.
  Previously this concept was implicit ("the curated subset ~100 names");
  this file makes the membership rule explicit.
- `dip-bounce-scorer.md` — consumes the list as its alert pool.

## Membership rule (v1)

A ticker is on the curated list for `asof_date` iff:

- It has a `trait_scores` row for `(intraday_range_trader, asof_date)`, AND
- It ranks in the **top 250** by that trait's score (desc), AND
- Its **30d median daily volume ≥ 1,000,000** shares/day, AND
- Its daily **ATR% ≥ 1.5%**.

Both are computed from the **same daily-bar pull** (IB `3m/1d`) — see *Volume
source* below — and cached on `curated_list.avg_daily_volume` /
`curated_list.daily_atr_pct`.

Three knobs, all named constants (`server/src/config/curatedList.ts`),
tunable from outcome data:

- `TARGET_SIZE = 250`
- `MIN_AVG_VOLUME = 1_000_000`
- `MIN_DAILY_ATR_PCT = 1.5`

`TARGET_SIZE` is a cap, not a floor. If only 180 names pass the gates the
list is 180. If 800 pass, the top 250 by trait score win.

**Volume + ATR source (Batch X3 → X4).** Both gates read the candidate's daily
bars from the **`daily_bars` SSOT** (`loadDailyBars`) — the volume gate takes the
**30d median** of `bars[].v`, the ATR gate takes ATR(14)/last-close. Neither reads
`universe.last_avg_volume` for the per-candidate gate (that column, now derived
*from* `daily_bars`, is for the universe-wide `catalystReversal` Stage-1
pre-filter). Median, not mean, so a single news-day volume spike can't sneak an
illiquid name through.

The list was originally (X3) computed from an **IB history** pull per candidate;
Batch X4 repointed it to `daily_bars` (Polygon-primary, weekend-safe), so the
cron is **no longer IB-gated** and the list rebuilds when IB history is down.
There is still **no single-day-volume fallback**: when a candidate has too few
bars in `daily_bars` it fails the gates rather than being admitted low-quality.
The history-context (why `universe.last_avg_volume` was never populated before X4)
lives in `data/sources.md` → Observations.

## Why pure `intraday_range_trader`

Of the three S2 traits, only `intraday_range_trader` is a *character*
signal — it captures whether the stock historically dips and recovers
within the session. The other two are *event* signals: `catalyst_reversal`
fires on today's news, `post_earnings_drift` on a recent report. Both are
transient and already enter the day's pool via `universe.auto_promoted`
from `catalyst_reversal` Stage 2; folding them into the curated-list rule
would double-count.

The curated list is the always-on character pool; event-driven additions
ride through the universe layer.

**Virtual-list rendering unions the two (2026-06-05).** Pool membership stays
pure-character, but the Intraday / Swing virtual lists
(`../screens/watchlist.md`) render `curated_list ∪ universe.auto_promoted`
event names — so `catalyst_reversal` / `post_earnings_drift` names appear with
a `catalyst` / `post-earnings` reason chip. List *ranking* is therefore a
composite (dip-bounce score for character names + the trait's own score for
event names) — see `dip-bounce-scorer.md` → Feeding the virtual lists.

Blending the three traits into the **pool membership** rule stays deferred (the
always-on pool is character-only); only the **virtual-list ranking** goes
composite now. Revisit membership-level blending from v1 hit-rate data.

## Refresh cadence

- **09:00 IDT nightly** — full refresh after `universeCron` + S2 trait
  scoring complete. Rewrites the `(asof_date = today)` rows. Same cron
  pass that computes `trait_scores` writes the curated list.
- **15:30 IDT pre-market** — incremental refresh: re-check membership for
  tickers showing significant overnight news / AH move. Drops tickers
  that no longer pass the gates; admits tickers that just crossed in
  (rare).

No mid-session refresh — character signals don't change in hours.

## Population & freshness (Batch X9)

Two seams were broken at ship and are fixed here (the lists weren't populating):

1. **Build race / date-coupling.** `curatedListCron` keyed strictly on
   `trait_scores (asof_date = today)`, but the trait producer writes today's rows
   *after* the cron's first tick → 0 seeds → the list never built. Fix: the cron
   **seeds from the latest available `intraday_range_trader` date** (and is
   sequenced after the producer), and consumers (`useVirtualList`) read the
   **latest** `curated_list` / `trait_scores` date, not strictly today.
2. **Staleness, surfaced not hidden.** "Latest" is bounded — past a **staleness
   cap (~2-3 trading days)** the list shows a "data stale" state instead of
   silently serving old membership. When the latest date ≠ today the FE shows an
   **"as of <date>" age badge** (`../screens/watchlist.md`). Membership is
   slow-moving *character* data, so days-old membership is safe to *display*;
   money-safety lives at the firing gate, not here — see `dip-bounce-scorer.md`
   → Fresh-price firing gate.
3. **Curated names get a `quotes` row.** The virtual lists *and* the scorer read
   `quotes`, but nothing wrote curated prices there (only held/watchlist were
   quoted) → curated rows were dropped on the join. Fix: seed `quotes` for the
   curated set from `universe.last_price` + latest `daily_bars` (close +
   sparkline), `canonical_source` daily-grain with an honest (stale) timestamp;
   the live pollers overwrite during session. Seeded/stale prices **render** but
   never **fire**.

## Persistence

`curated_list` table — see `../schema.md`. Keyed by `(conid, asof_date)`.
Realtime enabled (Screener FE + Watchlist chips subscribe).

Stale rows (older than 7 days) dropped by daily retention task.

## Consumers

- **`dip-bounce-scorer.md`** — runs both scorers on every poll write to
  any ticker in `curated ∪ active-watchlist ∪ held`; fires Discord pings to
  `#upside-intraday-suggestions` / `#upside-swing-suggestions`.
- **`band-engine.md`** — runs the walking-band engine on
  `curated ∪ active-watchlist ∪ held` (2026-06-05: widened from curated-only
  so every ticker on a *visible* imported list gets a band —
  `../screens/watchlist.md` → Engine coverage). The active-watchlist set is
  bounded by the user's visibility choices, so the IB-budget impact stays
  small.
- **`../screens/watchlist.md`** — renders the Intraday / Swing virtual lists
  (union with event-promoted names, composite rank, reason chips). Reshaped
  from the retired Screener tab with Batch X2 in `BUILD_QUEUE.md`.

## Cross-references

- Schema: `../schema.md` → `curated_list`
- Cron implementation: `../flows.md` → Curated-List Refresh Flow (added
  with the implementing batch X1)
