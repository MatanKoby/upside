// News-sentiment scoring knobs (Batch X7). The lexicon lives in
// services/news/lexicon.ts; these are the windowing + thresholds the pure scorer
// reads. Spec: spec/signals/news-signal.md.

// Trailing window an article counts in (the decay: an article ages out in 48h).
export const NEWS_LOOKBACK_HOURS = 48;

// Recency weighting inside the window — fresh news counts double the day-old.
export const NEWS_RECENT_HOURS = 24;
export const NEWS_RECENT_WEIGHT = 1.0;
export const NEWS_OLDER_WEIGHT = 0.5;

// A single article's raw lexicon sum saturates to ±1 at this magnitude, so one
// hyperbolic headline can't dominate the aggregate.
export const ARTICLE_CLAMP = 3;

// Label thresholds over the aggregate score (∈ ~[-1, +1]).
export const NEWS_BULLISH_SCORE = 0.35;
export const NEWS_BEARISH_SCORE = -0.35;

// Term weights — severe-tier terms (fraud / bankruptcy / FDA approval …) count
// double a normal-tier term.
export const BASE_WEIGHT = 1;
export const SEVERE_WEIGHT = 2;
