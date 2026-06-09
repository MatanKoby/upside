// Market hours detection for NYSE/NASDAQ.
// All times in America/New_York (ET). Returns one of 4 periods.

import type { MarketPeriod } from '../types/index.js';

// US market holidays — NYSE/NASDAQ full closures.
// Source: nyse.com/markets/hours-calendars. Refresh annually.
// Half-day closures (early close at 1pm ET on day-after-Thanksgiving etc.)
// are not modeled in MVP — they show as Regular session here. Add later.
const US_MARKET_HOLIDAYS: ReadonlySet<string> = new Set([
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26', // Good Friday
  '2027-05-31',
  '2027-06-18', // Juneteenth (observed)
  '2027-07-05', // Independence Day (observed)
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // Christmas (observed)
]);

function partsInTimezone(now: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday, 6 = Saturday
} {
  // Intl.DateTimeFormat is the standard-library way to get a date's components
  // in a specific timezone without bundling moment-tz.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: weekdayMap[get('weekday')] ?? 0,
  };
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function marketPeriodAt(now: Date = new Date()): MarketPeriod {
  const t = partsInTimezone(now);
  // Weekend
  if (t.weekday === 0 || t.weekday === 6) return 'closed';
  // Holiday
  if (US_MARKET_HOLIDAYS.has(isoDate(t.year, t.month, t.day))) return 'closed';

  const minutes = t.hour * 60 + t.minute;
  // Pre-market: 04:00 - 09:30 ET
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre-market';
  // Regular: 09:30 - 16:00 ET
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  // After-hours: 16:00 - 20:00 ET
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'after-hours';
  return 'closed';
}

export function isMarketActive(period: MarketPeriod): boolean {
  return period !== 'closed';
}

/** The ET calendar date (YYYY-MM-DD) for `now`. Used by zoneGapCleanup to
 *  clear the per-trading-day "via gap" badge exactly once per ET day. */
export function etDateString(now: Date = new Date()): string {
  const t = partsInTimezone(now);
  return isoDate(t.year, t.month, t.day);
}

/**
 * ISO timestamp of today's regular-session close (16:00 ET) for `now`'s ET
 * calendar date. Used as the expiry for an `intraday` playbook. DST-correct:
 * derives the ET↔UTC offset from `now` itself rather than assuming -4/-5.
 */
export function endOfRegularSessionEtIso(now: Date = new Date()): string {
  const t = partsInTimezone(now);
  // Treat the ET wall-clock components as if UTC, then subtract the difference
  // from the real instant to recover the ET offset (negative for ET).
  const wallAsUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute);
  const nowMin = Math.floor(now.getTime() / 60000) * 60000;
  const offsetMs = wallAsUtc - nowMin;
  const closeWallAsUtc = Date.UTC(t.year, t.month - 1, t.day, 16, 0);
  return new Date(closeWallAsUtc - offsetMs).toISOString();
}

/**
 * Resolve the instant whose ET wall-clock reads `y-mo-d hh:mi`. DST-correct:
 * guesses by treating the wall clock as UTC, then corrects using the ET offset
 * the guess actually lands in (two passes converge — our callers use 09:30 /
 * noon, far from the 02:00 DST transition, so there's no ambiguity).
 */
function etWallClockToInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = partsInTimezone(new Date(guess));
    const guessWallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const offsetMs = guessWallAsUtc - guess; // ET wall ahead of the instant (negative)
    guess = Date.UTC(y, mo - 1, d, h, mi) - offsetMs;
  }
  return new Date(guess);
}

/**
 * ISO timestamp of the next regular-session open (09:30 ET on a trading day)
 * strictly after `now`. If `now` is before today's 09:30 ET on a trading day,
 * returns today's open; otherwise walks forward past weekends + holidays.
 * Used by the job-queue `requiresRthOpen` gate to defer off-hours jobs instead
 * of failing them (see `../services/jobs/gates.ts`).
 */
export function nextRegularOpenEtIso(now: Date = new Date()): string {
  const t = partsInTimezone(now);
  let { year: y, month: mo, day: d } = t;
  for (let i = 0; i < 14; i++) {
    const open = etWallClockToInstant(y, mo, d, 9, 30);
    const p = partsInTimezone(open);
    const isTradingDay =
      p.weekday >= 1 && p.weekday <= 5 && !US_MARKET_HOLIDAYS.has(isoDate(p.year, p.month, p.day));
    if (isTradingDay && open.getTime() > now.getTime()) return open.toISOString();
    // Advance one ET calendar day via noon (DST-safe — noon never shifts day).
    const noonNext = new Date(etWallClockToInstant(y, mo, d, 12, 0).getTime() + 24 * 60 * 60_000);
    const np = partsInTimezone(noonNext);
    y = np.year; mo = np.month; d = np.day;
  }
  // Unreachable in practice (≤14d covers any holiday gap); safe fallback.
  return new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
}

/**
 * US trading days from `entry` through `now`, both ET-calendar-day inclusive.
 * Returns 1 on the entry day itself (so the %/day metric never divides by 0),
 * incrementing each subsequent weekday that isn't a market holiday. Returns 0
 * if `entry` is in the future relative to `now`.
 *
 * Used by ibPricePoller to compute `trading_days_held` from `first_seen_at`.
 */
export function tradingDaysHeld(entry: Date, now: Date = new Date()): number {
  const entryParts = partsInTimezone(entry);
  const nowParts = partsInTimezone(now);
  // Walk noon-UTC of each calendar day so partsInTimezone resolves to the
  // intended ET date regardless of DST.
  let cursor = Date.UTC(entryParts.year, entryParts.month - 1, entryParts.day, 12);
  const endDay = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12);
  if (cursor > endDay) return 0;
  let count = 0;
  while (cursor <= endDay) {
    const p = partsInTimezone(new Date(cursor));
    const isWeekday = p.weekday >= 1 && p.weekday <= 5;
    const isHoliday = US_MARKET_HOLIDAYS.has(isoDate(p.year, p.month, p.day));
    if (isWeekday && !isHoliday) count++;
    cursor += 24 * 60 * 60 * 1000;
  }
  return count;
}
