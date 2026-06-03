// Band engine — vol_regime_shift daily flag (Batch S3).
//
// Daily-resolution companion to Layer 2's intraday scalar. When the last 5
// sessions' ATR > 2× the prior 30 sessions' ATR, the stock has stepped into
// a new vol regime (post-catalyst REPL is the canonical case). The static
// `intraday_stats` baseline is too slow to reflect this — it'll catch up
// over weeks. Flipping a daily flag is the cheap correctness hedge: the FE
// chip warns "vol regime shift — bands lower confidence."
//
// Spec: spec/signals/band-engine.md → vol_regime_shift flag. Per spec, this
// flag does NOT auto-truncate the 60d lookback (that's a Track-10 deferred
// item — see roadmap.md). It only sets the flag.

import { atr } from './volScalar.js';

const RECENT_SESSIONS = 5;
const PRIOR_SESSIONS = 30;
const SHIFT_RATIO_THRESHOLD = 2;

export interface SessionBar {
  /** Calendar date (YYYY-MM-DD) used to group bars by session. */
  date: string;
  h: number;
  l: number;
  c: number;
}

/**
 * `sessionBars` is the per-session aggregate bar (one bar per trading day)
 * — typically session H, L, C derived from 5-min bars grouped by session.
 * Pass them oldest-first; the function uses the last RECENT_SESSIONS as
 * "recent" and the RECENT_SESSIONS preceding those as "prior baseline."
 */
export function computeVolRegimeShift(sessionBars: SessionBar[]): boolean {
  if (sessionBars.length < RECENT_SESSIONS + PRIOR_SESSIONS) return false;
  const recent = sessionBars.slice(-RECENT_SESSIONS);
  const priorEnd = sessionBars.length - RECENT_SESSIONS;
  const priorStart = Math.max(0, priorEnd - PRIOR_SESSIONS);
  const prior = sessionBars.slice(priorStart, priorEnd);

  const recentAtr = atr(recent);
  const priorAtr = atr(prior);
  if (recentAtr == null || priorAtr == null || priorAtr <= 0) return false;

  return recentAtr / priorAtr > SHIFT_RATIO_THRESHOLD;
}
