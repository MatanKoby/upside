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

**Volume source (2026-06-06).** The volume gate reads the **30d median** of the
daily bars the cron already pulls for ATR (`bars[].v`), *not*
`universe.last_avg_volume`. That column is never populated — `universeCron`
writes `null`, the `marketCapRefreshCron` "bootstrap" its header claims was never
implemented, and Finnhub `profile2` carries no average volume — so the old
pre-filter silently rejected every candidate and the list stayed empty. Deriving
median ADV from the ATR bars is **zero-marginal-cost** (those bars are already
fetched) and internally consistent with the ATR number. Median, not mean, so a
single news-day volume spike can't sneak an illiquid name through. There is **no
single-day-volume fallback**: on a day IB history is unavailable the list stays
empty rather than admit low-quality-gated names. Precomputing
`universe.last_avg_volume` from Polygon 30d aggregates — a cheap universe-wide
pre-filter that also survives IB outages and feeds `catalystReversal` — is a
deferred scale/robustness improvement (`BUILD_QUEUE.md` → Batch X4).

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
