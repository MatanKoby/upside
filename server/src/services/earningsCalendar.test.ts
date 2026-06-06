import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./finnhub.js', () => ({
  earningsCalendarRange: vi.fn(async () => [{ symbol: 'AAA', date: '2026-06-05' }]),
}));

import { earningsCalendarRange } from './finnhub.js';
import { getEarningsWindow, _resetEarningsCache } from './earningsCalendar.js';

describe('earningsCalendar — shared daily pull (Batch X6)', () => {
  beforeEach(() => {
    _resetEarningsCache();
    vi.mocked(earningsCalendarRange).mockReset();
    vi.mocked(earningsCalendarRange).mockResolvedValue([{ symbol: 'AAA', date: '2026-06-05' }]);
  });

  it('fetches once and serves the memo for repeat callers the same day', async () => {
    const a = await getEarningsWindow();
    const b = await getEarningsWindow();
    expect(earningsCalendarRange).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('coalesces concurrent callers into a single fetch', async () => {
    const [a, b, c] = await Promise.all([
      getEarningsWindow(),
      getEarningsWindow(),
      getEarningsWindow(),
    ]);
    expect(earningsCalendarRange).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not poison the cache on failure — next call retries', async () => {
    vi.mocked(earningsCalendarRange).mockRejectedValueOnce(new Error('boom'));
    await expect(getEarningsWindow()).rejects.toThrow('boom');
    const rows = await getEarningsWindow();
    expect(rows).toHaveLength(1);
    expect(earningsCalendarRange).toHaveBeenCalledTimes(2);
  });
});
