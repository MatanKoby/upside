// Composite-rank weights for the Intraday / Swing virtual lists (Batch X2).
//
// These are CALIBRATION SEEDS, not tuned values — there is no forward-tracked
// outcome data yet (X1 forward-tracker needs ~a month of real fires). Seeded by
// the same throwaway reasoning as the scorer weights in
// server/src/config/dipBounceScorer.ts: weight the *character* signal highest,
// then the recent fire (so a just-crossed name rises), then the rolling
// hit-rate, then liquidity. Re-tune from `signal_hit_rate_30d` once data exists.
// See spec/signals/dip-bounce-scorer.md → Feeding the virtual lists.

export type VirtualKind = 'intraday' | 'swing';
export type ReasonChip = 'dip' | 'catalyst' | 'post-earnings';

// How many rows each leaderboard shows (the lists are living top-N, not the
// whole pool). The composite naturally sinks low-relevance names below the cut.
export const VIRTUAL_LIST_TOP_N = 30;

// Both lists draw from the same union (curated_list ∪ event-trait names) and
// differ only in their rank lens. Every term is normalised to roughly 0..100
// before weighting; the weights below need not sum to 1 (the absolute scale is
// irrelevant — only the relative ordering matters).
export const INTRADAY_WEIGHTS = {
  character: 1.0, // intraday_range_trader score (the `dip` character)
  catalyst: 0.8, // catalyst_reversal trait score (event, both-lists)
  fired: 0.6, // +100 when an intraday_dip_bounce fire is live (within cooldown)
  hitRate: 0.4, // rolling-30d intraday hit-rate %
  news: 0.5, // news sentiment nudge (Batch X7) — good lifts / bad sinks
} as const;

export const SWING_WEIGHTS = {
  postEarnings: 1.0, // post_earnings_drift trait score (the `post-earnings` character)
  catalyst: 0.8, // catalyst_reversal trait score (event, both-lists)
  character: 0.5, // intraday_range_trader score — weak swing base (liquid ATR names)
  fired: 0.6, // +100 when a swing_dip_bounce fire is live (within cooldown)
  hitRate: 0.4, // rolling-30d swing hit-rate %
  news: 0.5, // news sentiment nudge (Batch X7) — good lifts / bad sinks
} as const;

// news_sentiment.score is ∈ ~[-1,+1]; scale it onto the same ~[-100,100] range
// the other rank terms use before weighting.
export const NEWS_RANK_SCALE = 100;

// A fire counts as "live" (drives the ⚡ marker + the fired rank boost) while
// inside the scorer's cooldown window — matches the BE cooldowns so the FE and
// the Discord channel agree on what's currently firing.
export const FIRE_LIVE_WINDOW_HOURS = {
  intraday_dip_bounce: 4,
  swing_dip_bounce: 24,
} as const;

// Rolling-30d hit-rate window for the per-row column (forward-tracker).
export const HIT_RATE_WINDOW_DAYS = 30;

// Which outcome offset + return threshold each scorer's hit-rate is measured at
// (mirrors the signal_hit_rate_30d view; we recompute per-conid client-side
// because the view aggregates per-kind, not per-ticker).
export const HIT_RATE_DEF = {
  intraday_dip_bounce: { offset: '+2h', thresholdPct: 1 },
  swing_dip_bounce: { offset: '+3d', thresholdPct: 5 },
} as const;

// Entry-temperature thresholds (Batch X12) — position within the walking-band
// channel [low_band, high_band]: 0 at the buy band, 1 at the sell band. See
// spec/screens/watchlist.md → Reading a row. Tunable; FE-side presentation only.
export const NEAR_BAND_FRAC = 0.33; // band position ≤ this → 🟡 near (approaching the buy band)
export const EXTENDED_BAND_FRAC = 0.8; // band position ≥ this → 🧊 extended (no dip left to buy)

// Rolling-30d hit-rate tiers that promote/demote a row in the factor-flag tally.
export const GOOD_HIT_PCT = 55; // ≥ → a 🟢 tailwind
export const LOW_HIT_PCT = 40; // < → a 🔴 headwind
