// post_earnings_drift trait — Batch S2.
//
// Post-earnings positive drift: stocks that reported within the last 1–3
// trading days AND closed up ≥2% on the report day tend to drift in the
// same direction for several sessions. Per
// spec/signals/screener-universe.md → post_earnings_drift.
//
// Pure scorer; producer feeds in earnings-day close + prior close + days-
// since-earnings. Daily bars are pulled by the worker (ibHistory '1m'
// '1d') and the producer-side helper extracts the report-day vs prior
// values.

const POP_THRESHOLD_PCT = 2.0;
const MAX_DAYS_SINCE = 5;          // shelf-life floor (spec: drop beyond 5d)
const STRONG_POP_PCT = 5.0;        // saturation point for "big report" bonus

export interface PostEarningsDriftInput {
  /** Report-day close-to-close move %. Positive = the popped direction. */
  report_day_pop_pct: number;
  /** Days since the earnings report (1 = same-day, 2 = next session, ...). */
  days_since_earnings: number;
  /** Today's price, for FE display. */
  today_price: number;
}

export interface PostEarningsDriftResult {
  score: number;
  payload: {
    report_day_pop_pct: number;
    days_since_earnings: number;
    today_price: number;
  };
}

/**
 * Score gate: report-day pop ≥ +2.0% AND days_since_earnings ≤ 5.
 * Returns null when either fails.
 *
 * Score (0-100):
 *   - Pop magnitude (0-60): saturates at POP_THRESHOLD…STRONG_POP_PCT linearly.
 *   - Freshness (0-40): linear decay over MAX_DAYS_SINCE.
 */
export function scorePostEarningsDrift(
  input: PostEarningsDriftInput,
): PostEarningsDriftResult | null {
  const { report_day_pop_pct, days_since_earnings, today_price } = input;

  if (!Number.isFinite(report_day_pop_pct) || report_day_pop_pct < POP_THRESHOLD_PCT) return null;
  if (!Number.isFinite(days_since_earnings) || days_since_earnings < 1) return null;
  if (days_since_earnings > MAX_DAYS_SINCE) return null;

  // Pop magnitude saturating between threshold (0pts) and STRONG_POP (60pts).
  const popClipped = Math.min(report_day_pop_pct, STRONG_POP_PCT);
  const popNormalized = (popClipped - POP_THRESHOLD_PCT) / (STRONG_POP_PCT - POP_THRESHOLD_PCT);
  const popScore = popNormalized * 60;

  // Freshness — strongest within 1-2 days, decays linearly to 0 at MAX.
  const freshScore = ((MAX_DAYS_SINCE - days_since_earnings) / (MAX_DAYS_SINCE - 1)) * 40;

  const score = Math.round(popScore + freshScore);

  return {
    score,
    payload: {
      report_day_pop_pct: Number(report_day_pop_pct.toFixed(2)),
      days_since_earnings,
      today_price: Number(today_price.toFixed(2)),
    },
  };
}

// ---------------------------------------------------------------------------
// Daily-bar helper — computes (report_day_pop_pct, days_since) from raw
// bars + report date. Used by the worker handler. Pure / testable here.
// ---------------------------------------------------------------------------

export interface DailyBarMin {
  t: number;   // unix ms (session date)
  c: number;
}

/**
 * Find the report-day close-to-close pop given bars + a report date. Bars
 * are oldest-first. Returns null when the report date isn't in the series
 * (e.g. stale or unfamiliar symbol) or the prior session is missing.
 *
 * `reportDate` is YYYY-MM-DD in America/New_York wall-clock terms — the
 * producer derives it from Finnhub's `/calendar/earnings.date` field.
 */
export function findReportDayPop(
  bars: DailyBarMin[],
  reportDate: string,
): { report_day_pop_pct: number; days_since_earnings: number; today_close: number } | null {
  if (bars.length < 2) return null;

  const reportTs = isoDateToUtcMs(reportDate);
  if (reportTs == null) return null;

  // Find the bar whose ET-date matches the report date.
  const sameOrAfter = bars.findIndex((b) => etDateOf(b.t) >= reportDate);
  if (sameOrAfter < 1) return null;
  const reportBar = bars[sameOrAfter];
  if (etDateOf(reportBar!.t) !== reportDate) return null;
  const priorBar = bars[sameOrAfter - 1];
  if (!priorBar || !Number.isFinite(priorBar.c) || priorBar.c <= 0) return null;
  if (!Number.isFinite(reportBar!.c)) return null;

  const pop = ((reportBar!.c - priorBar.c) / priorBar.c) * 100;

  // days_since_earnings = number of trading sessions elapsed counting today
  // as the latest bar. The last bar in the array is "today" (or yesterday,
  // depending on when the cron ran).
  const days_since_earnings = bars.length - sameOrAfter;
  const today_close = bars[bars.length - 1]!.c;

  return { report_day_pop_pct: pop, days_since_earnings, today_close };
}

function etDateOf(tsMs: number): string {
  const d = new Date(tsMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isoDateToUtcMs(d: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const ms = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}
