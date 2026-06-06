// Curated-list membership knobs (Batch X1). Tunable from outcome data; no
// magic numbers in buildCuratedList. See spec/signals/curated-list.md →
// Membership rule.

export const TARGET_SIZE = 250; // cap, not a floor — top-N by trait score
export const MIN_AVG_VOLUME = 1_000_000; // 30d median shares/day (computed from IB daily bars in curatedListCron; see spec/signals/curated-list.md → Volume source)
export const MIN_DAILY_ATR_PCT = 1.5; // daily ATR as a % of price
