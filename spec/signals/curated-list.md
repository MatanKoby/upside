# Curated List

Auto-maintained pool of ~200-300 "high-potential dip-bounce" names. Decides
membership of the alert pool that `dip-bounce-scorer.md` fires on and the
walking-band pool that `band-engine.md` runs Layer 3 against. Also the
source data for the Screener tab's ranked lists (`screens/screener.md`,
reshaping with Batch X2).

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
- `universe.last_avg_volume ≥ 1,000,000` shares/day (30d median), AND
- Its daily ATR% ≥ 1.5% (computed from the same daily-bar pull that feeds
  `intraday_stats`; cached on `curated_list.daily_atr_pct`).

Three knobs, all named constants (`server/src/config/curatedList.ts`),
tunable from outcome data:

- `TARGET_SIZE = 250`
- `MIN_AVG_VOLUME = 1_000_000`
- `MIN_DAILY_ATR_PCT = 1.5`

`TARGET_SIZE` is a cap, not a floor. If only 180 names pass the gates the
list is 180. If 800 pass, the top 250 by trait score win.

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

A composite-rank variant (blending all three traits into the membership
rule) is deferred — see `../roadmap.md` → "Curated list — composite
ranking" once the v1 hit-rate data warrants the change.

## Refresh cadence

- **09:00 IDT nightly** — full refresh after `universeCron` + S2 trait
  scoring complete. Rewrites the `(asof_date = today)` rows. Same cron
  pass that computes `trait_scores` writes the curated list.
- **15:30 IDT pre-market** — incremental refresh: re-check membership for
  tickers showing significant overnight news / AH move. Drops tickers
  that no longer pass the gates; admits tickers that just crossed in
  (rare).

No mid-session refresh — character signals don't change in hours.

## Persistence

`curated_list` table — see `../schema.md`. Keyed by `(conid, asof_date)`.
Realtime enabled (Screener FE + Watchlist chips subscribe).

Stale rows (older than 7 days) dropped by daily retention task.

## Consumers

- **`dip-bounce-scorer.md`** — runs both scorers on every poll write to
  any curated-list ticker; fires Discord pings to
  `#upside-intraday-suggestions` / `#upside-swing-suggestions`.
- **`band-engine.md`** — runs Layer 3 (walking-band state machine) on
  this list only. Layers 1 & 2 (session regime classifier + vol scalar)
  also restrict to this pool to stay within the IB usage budget
  documented in `screener-universe.md` → Caching + staggering.
- **`../screens/screener.md`** — renders the list as two ranked lists
  ("Intraday suggestions" / "Swing suggestions") sorted by the composite
  scores from `dip-bounce-scorer.md`. Reshape ships with Batch X2 in
  `BUILD_QUEUE.md`.

## Cross-references

- Schema: `../schema.md` → `curated_list`
- Cron implementation: `../flows.md` → Curated-List Refresh Flow (added
  with the implementing batch X1)
