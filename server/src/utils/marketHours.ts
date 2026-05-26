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
