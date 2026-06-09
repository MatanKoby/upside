// Unit tests for the per-action gates (Batch X10). The gate factories take an
// injectable clock so we can pin "now" to known ET wall-clock instants without
// mocking Date. June 2026 is EDT (UTC-4): 09:30 ET = 13:30 UTC. 2026-06-09 is
// a Tuesday, 2026-06-13 a Saturday, 2026-06-15 the following Monday.

import { describe, it, expect } from 'vitest';
import { requiresRthOpen, requiresMarketOpen } from './gates.js';
import type { JobRow } from './queue.js';

const at = (iso: string) => () => new Date(iso);
const PAYLOAD: Record<string, unknown> = {};
const JOB = {} as JobRow;

describe('requiresRthOpen', () => {
  it('is ready during the regular cash session', async () => {
    const g = requiresRthOpen(at('2026-06-09T14:00:00Z')); // 10:00 EDT, Tue
    expect(await g(PAYLOAD, JOB)).toEqual({ ready: true });
  });

  it('defers a pre-market claim to today 09:30 ET', async () => {
    const g = requiresRthOpen(at('2026-06-09T12:00:00Z')); // 08:00 EDT
    const r = await g(PAYLOAD, JOB);
    expect(r.ready).toBe(false);
    expect(r.retryAt?.toISOString()).toBe('2026-06-09T13:30:00.000Z');
  });

  it('defers an after-hours claim to the next trading day 09:30 ET', async () => {
    const g = requiresRthOpen(at('2026-06-09T21:00:00Z')); // 17:00 EDT, Tue
    const r = await g(PAYLOAD, JOB);
    expect(r.ready).toBe(false);
    expect(r.retryAt?.toISOString()).toBe('2026-06-10T13:30:00.000Z'); // Wed
  });

  it('defers a weekend claim to Monday 09:30 ET', async () => {
    const g = requiresRthOpen(at('2026-06-13T16:00:00Z')); // Saturday
    const r = await g(PAYLOAD, JOB);
    expect(r.ready).toBe(false);
    expect(r.retryAt?.toISOString()).toBe('2026-06-15T13:30:00.000Z'); // Mon
  });
});

describe('requiresMarketOpen', () => {
  it('is ready in pre-market (any active session counts)', async () => {
    const g = requiresMarketOpen(at('2026-06-09T12:00:00Z')); // 08:00 EDT
    expect(await g(PAYLOAD, JOB)).toEqual({ ready: true });
  });

  it('defers when fully closed (weekend) to the next regular open', async () => {
    const g = requiresMarketOpen(at('2026-06-13T16:00:00Z')); // Saturday
    const r = await g(PAYLOAD, JOB);
    expect(r.ready).toBe(false);
    expect(r.retryAt?.toISOString()).toBe('2026-06-15T13:30:00.000Z');
  });
});
