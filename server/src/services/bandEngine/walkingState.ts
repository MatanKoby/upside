// Band engine — Layer 3: walking band-state machine (Batch S3).
//
// Bands walk with intraday structure instead of being frozen at open. State:
// `anchor_low` (last local-low pivot), `anchor_high` (last local-high pivot),
// `running_max` (running max since last low-anchor), `running_min` (running
// min since last high-anchor), `leg_direction` ('up' | 'down' | null at seed).
// At 16:30 IDT seed: anchor_low = anchor_high = today_open, both extrema =
// open, leg_direction = null, current_low_band / current_high_band = null
// (no leg established yet — bands publish on first anchor).
//
// Re-anchor trigger: observed reversal from a running extremum ≥ reversal
// threshold (= 0.5 × today's 5-min ATR). NOT a touch of the predicted band —
// reality leads, prediction informs.
//
// Leg direction is explicit: after a low-anchor we're on an upward leg
// (only high-anchors fire next); after a high-anchor we're on a downward leg
// (only low-anchors fire next). At seed either side can fire first; the
// reversal that lands first sets the initial direction. Without this state
// the same-side anchor would re-fire as price continued past it.
//
// Spec: spec/signals/band-engine.md → Layer 3.
//
// Note on fade-pct sourcing: the spec calls for `p50_high_fade_pct` and
// `p50_low_fade_pct` from intraday_stats. The current `intraday_stats` schema
// (stats.md) carries only `intraday_low_pct_p50` (typical session drawdown);
// it does NOT split the typical up-leg vs down-leg fade. v1 uses the same
// p50 value for both directions as a symmetric proxy — see band-engine.md
// → "Fade-pct sourcing (v1 simplification)" note. Per-direction percentiles
// are a Track-10 sharpening (roadmap.md).

export type LegDirection = 'up' | 'down' | null;

export interface AnchorEvent {
  kind: 'low' | 'high';
  price: number;
  ts: string;
}

export interface BandWalkState {
  anchor_low: number;
  anchor_high: number;
  running_max: number;
  running_min: number;
  leg_direction: LegDirection;
  anchors: AnchorEvent[];
  current_low_band: number | null;
  current_high_band: number | null;
}

export interface BandWalkTickInputs {
  state: BandWalkState;
  price: number;
  ts: string;
  /** Reversal trigger = 0.5 × today's 5-min ATR. Pass already-multiplied. */
  reversalThreshold: number;
  /** Typical up-leg fade pct from intraday_stats (positive number, e.g. 2.5 for 2.5%). */
  upFadePct: number;
  /** Typical down-leg fade pct from intraday_stats (positive number, e.g. 2.5 for 2.5%). */
  downFadePct: number;
  /** Multiplier from Layer 2 (1.0 baseline, 1.5 high-vol, 0.7 calm). */
  volScalar: number;
}

export interface BandWalkTickResult {
  state: BandWalkState;
  anchored: 'low' | 'high' | null;
}

/** Initial state at 16:30 IDT regular open. */
export function seedBandWalkState(todayOpen: number): BandWalkState {
  return {
    anchor_low: todayOpen,
    anchor_high: todayOpen,
    running_max: todayOpen,
    running_min: todayOpen,
    leg_direction: null,
    anchors: [],
    current_low_band: null,
    current_high_band: null,
  };
}

function publishAfterLowAnchor(L: number, upFadePct: number, downFadePct: number, scalar: number) {
  const next_high_band = L * (1 + (upFadePct / 100) * scalar);
  const next_low_band = next_high_band * (1 - (downFadePct / 100) * scalar);
  return { current_low_band: next_low_band, current_high_band: next_high_band };
}

function publishAfterHighAnchor(H: number, upFadePct: number, downFadePct: number, scalar: number) {
  const next_low_band = H * (1 - (downFadePct / 100) * scalar);
  const next_high_band = next_low_band * (1 + (upFadePct / 100) * scalar);
  return { current_low_band: next_low_band, current_high_band: next_high_band };
}

/**
 * Apply one price tick to the walking state. Returns the new state + which
 * kind of anchor (if any) fired. Caller uses `anchored` to decide whether
 * to write a publication row to band_state.
 *
 * At seed (`leg_direction === null`): either side can fire first. We check
 * high-anchor first — in the rare tie where both crossed threshold on the
 * same tick (only possible at seed), the high-anchor wins. Deterministic
 * and documented rather than randomized.
 */
export function tickBandWalk(inp: BandWalkTickInputs): BandWalkTickResult {
  const { price, ts, reversalThreshold } = inp;
  const upFadePct = Math.max(0, inp.upFadePct);
  const downFadePct = Math.max(0, inp.downFadePct);
  const scalar = Math.max(0, inp.volScalar);
  const s: BandWalkState = {
    ...inp.state,
    anchors: [...inp.state.anchors],
  };

  if (!Number.isFinite(price) || !Number.isFinite(reversalThreshold) || reversalThreshold <= 0) {
    return { state: s, anchored: null };
  }

  s.running_max = Math.max(s.running_max, price);
  s.running_min = Math.min(s.running_min, price);

  // High-anchor check is open at seed or when we're tracking an upward leg.
  const checkHigh = s.leg_direction === null || s.leg_direction === 'up';
  // Low-anchor check is open at seed or when we're tracking a downward leg.
  const checkLow = s.leg_direction === null || s.leg_direction === 'down';

  let anchored: 'low' | 'high' | null = null;

  if (checkHigh && s.running_max - price >= reversalThreshold) {
    s.anchor_high = s.running_max;
    s.anchors.push({ kind: 'high', price: s.anchor_high, ts });
    const bands = publishAfterHighAnchor(s.anchor_high, upFadePct, downFadePct, scalar);
    s.current_low_band = bands.current_low_band;
    s.current_high_band = bands.current_high_band;
    s.running_min = price;
    s.leg_direction = 'down';
    anchored = 'high';
  } else if (checkLow && price - s.running_min >= reversalThreshold) {
    s.anchor_low = s.running_min;
    s.anchors.push({ kind: 'low', price: s.anchor_low, ts });
    const bands = publishAfterLowAnchor(s.anchor_low, upFadePct, downFadePct, scalar);
    s.current_low_band = bands.current_low_band;
    s.current_high_band = bands.current_high_band;
    s.running_max = price;
    s.leg_direction = 'up';
    anchored = 'low';
  }

  return { state: s, anchored };
}
