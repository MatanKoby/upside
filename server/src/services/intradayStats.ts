// Intraday statistics — pure function (Batch B).
//
// Given 5-min OHLCV bars across multiple sessions, compute per-symbol
// distributions of: open fade %, close fade %, typical intraday-low % from
// open. Pure / deterministic → tested via vitest the same way as
// `entryZones`.
//
// Conventions:
// - A 5-min bar has `t` (unix ms), `o`, `h`, `l`, `c`, `v`. Same shape as
//   ibGateway.history(conid, '<>d', '5min') bars.
// - Sessions are bucketed by ET calendar date (open is the first regular-
//   session bar of that date, close is the last). We don't try to detect
//   half-day closes — they're rare and a half-day naturally shows up as a
//   shorter session.
// - Open fade window = first FADE_BARS bars after open (default 6 → ~30 min).
// - Close fade window = last FADE_BARS bars before close.
// - Intraday low % = (open - session_low) / open * 100. Positive when low <
//   open (the common case); negative when the open IS the low (rare; would
//   indicate a session that only went up).
// - Lookback = the most recent N distinct sessions in the bar series.

export interface IntradayBar {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

export interface IntradayStats {
  open_fade_pct_mean:    number | null;
  open_fade_pct_p50:     number | null;
  open_fade_pct_p25:     number | null;
  close_fade_pct_mean:   number | null;
  close_fade_pct_p50:    number | null;
  close_fade_pct_p25:    number | null;
  intraday_low_pct_mean: number | null;
  intraday_low_pct_p50:  number | null;
  intraday_low_pct_p75:  number | null;
  sample_size:           number;
  lookback_days:         number;
}

export interface ComputeIntradayStatsOpts {
  bars: IntradayBar[];
  /** How many recent sessions to include. Default 60. */
  lookbackDays?: number;
  /** Bars in the fade window (default 6 = ~30 min of 5-min bars). */
  fadeBars?: number;
}

// New York date string ("YYYY-MM-DD") for a unix-ms timestamp. Cheap to
// implement without bringing in a timezone library — Intl handles DST.
function etDate(tsMs: number): string {
  const d = new Date(tsMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function groupBySession(bars: IntradayBar[]): Map<string, IntradayBar[]> {
  const map = new Map<string, IntradayBar[]>();
  for (const b of bars) {
    const key = etDate(b.t);
    const list = map.get(key);
    if (list) list.push(b);
    else map.set(key, [b]);
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t);
  return map;
}

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo] ?? null;
  const w = idx - lo;
  return (sortedAsc[lo] ?? 0) * (1 - w) + (sortedAsc[hi] ?? 0) * w;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeIntradayStats(opts: ComputeIntradayStatsOpts): IntradayStats {
  const lookbackDays = opts.lookbackDays ?? 60;
  const fadeBars = opts.fadeBars ?? 6;
  const sessions = groupBySession(opts.bars);
  // Most recent N sessions, oldest first → newest. Map preserves insertion
  // order; sort by date so we don't depend on caller ordering.
  const sessionKeys = Array.from(sessions.keys()).sort();
  const recent = sessionKeys.slice(-lookbackDays);

  const openFades: number[] = [];
  const closeFades: number[] = [];
  const intradayLows: number[] = [];

  for (const key of recent) {
    const bars = sessions.get(key) ?? [];
    if (bars.length === 0) continue;
    const open = bars[0]!.o;
    const close = bars[bars.length - 1]!.c;
    if (!Number.isFinite(open) || open <= 0) continue;

    // Open fade: open → close of bar #fadeBars-1 (so the first fadeBars bars).
    const openFadeEnd = bars[Math.min(fadeBars, bars.length) - 1]?.c;
    if (openFadeEnd != null && Number.isFinite(openFadeEnd)) {
      openFades.push(pct(open, openFadeEnd));
    }

    // Close fade: open of the LAST fadeBars bars → close.
    const closeFadeStartIdx = Math.max(0, bars.length - fadeBars);
    const closeFadeStart = bars[closeFadeStartIdx]?.o;
    if (closeFadeStart != null && Number.isFinite(closeFadeStart) && closeFadeStart > 0) {
      closeFades.push(pct(closeFadeStart, close));
    }

    // Intraday low %: how far the session's low was below the open. Positive
    // = the low was below open (the common, actionable case).
    const sessionLow = bars.reduce((m, b) => Math.min(m, b.l), bars[0]!.l);
    if (Number.isFinite(sessionLow)) {
      intradayLows.push(pct(sessionLow, open)); // open-vs-low; positive when low < open
    }
  }

  const openFadesSorted = [...openFades].sort((a, b) => a - b);
  const closeFadesSorted = [...closeFades].sort((a, b) => a - b);
  const lowsSorted = [...intradayLows].sort((a, b) => a - b);

  return {
    open_fade_pct_mean:  mean(openFades),
    open_fade_pct_p50:   percentile(openFadesSorted, 0.5),
    open_fade_pct_p25:   percentile(openFadesSorted, 0.25),

    close_fade_pct_mean: mean(closeFades),
    close_fade_pct_p50:  percentile(closeFadesSorted, 0.5),
    close_fade_pct_p25:  percentile(closeFadesSorted, 0.25),

    intraday_low_pct_mean: mean(intradayLows),
    intraday_low_pct_p50:  percentile(lowsSorted, 0.5),
    intraday_low_pct_p75:  percentile(lowsSorted, 0.75),  // deeper dip

    sample_size: recent.length,
    lookback_days: lookbackDays,
  };
}
