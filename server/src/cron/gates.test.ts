// cron gate tests (Batch ARCH-9). The market gates are pure over marketPeriodAt;
// ibAuthGate must require BOTH authenticated and connected and must swallow a
// status() rejection into `false` (IB down ⇒ skip the tick, never crash the loop).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../adapters/ib/ibGatewayAdapter.js', () => ({
  ibGateway: { status: vi.fn() },
}));
vi.mock('../utils/marketHours.js', () => ({ marketPeriodAt: vi.fn() }));

import { ibAuthGate, marketRegularGate, marketRegularOrAfterHoursGate } from './gates.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { marketPeriodAt } from '../utils/marketHours.js';

const mockStatus = ibGateway.status as unknown as ReturnType<typeof vi.fn>;
const mockPeriod = marketPeriodAt as unknown as ReturnType<typeof vi.fn>;

describe('ibAuthGate', () => {
  beforeEach(() => mockStatus.mockReset());

  it('true only when authenticated AND connected', async () => {
    mockStatus.mockResolvedValue({ authenticated: true, connected: true });
    expect(await ibAuthGate()).toBe(true);
  });
  it('false when not authenticated', async () => {
    mockStatus.mockResolvedValue({ authenticated: false, connected: true });
    expect(await ibAuthGate()).toBe(false);
  });
  it('false when not connected', async () => {
    mockStatus.mockResolvedValue({ authenticated: true, connected: false });
    expect(await ibAuthGate()).toBe(false);
  });
  it('false (not throw) when status() rejects', async () => {
    mockStatus.mockRejectedValueOnce(new Error('IB down'));
    await expect(ibAuthGate()).resolves.toBe(false);
  });
});

describe('market gates', () => {
  beforeEach(() => mockPeriod.mockReset());

  it('marketRegularGate true only in regular', () => {
    mockPeriod.mockReturnValue('regular');
    expect(marketRegularGate()).toBe(true);
    for (const p of ['pre-market', 'after-hours', 'closed']) {
      mockPeriod.mockReturnValue(p);
      expect(marketRegularGate()).toBe(false);
    }
  });

  it('marketRegularOrAfterHoursGate true in regular + after-hours only', () => {
    for (const p of ['regular', 'after-hours']) {
      mockPeriod.mockReturnValue(p);
      expect(marketRegularOrAfterHoursGate()).toBe(true);
    }
    for (const p of ['pre-market', 'closed']) {
      mockPeriod.mockReturnValue(p);
      expect(marketRegularOrAfterHoursGate()).toBe(false);
    }
  });
});
