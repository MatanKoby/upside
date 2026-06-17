// ibReconnect tests (Batch ARCH-10) — the edge detector fires the staleness
// catch-up exactly once per disconnected→connected transition, staggers the
// triggers, and treats an unreachable gateway as "down".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../adapters/ib/ibGatewayAdapter.js', () => ({ ibGateway: { status: vi.fn() } }));

import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { onIbReconnect, detectIbReconnect, __test } from './ibReconnect.js';
import type { CronHandle } from '../kernel/scheduler.js';

const mockStatus = ibGateway.status as unknown as ReturnType<typeof vi.fn>;
const up = { authenticated: true, connected: true };
const down = { authenticated: false, connected: false };

function fakeHandle(trigger: () => void): CronHandle {
  return { start() {}, stop() {}, trigger };
}

describe('ibReconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockStatus.mockReset();
    __test.reset();
  });
  afterEach(() => vi.useRealTimers());

  it('fires registered triggers on a disconnected→connected edge, once', async () => {
    const trig = vi.fn();
    onIbReconnect(fakeHandle(trig));

    mockStatus.mockResolvedValue(down);
    await detectIbReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).not.toHaveBeenCalled(); // still down

    mockStatus.mockResolvedValue(up);
    await detectIbReconnect(); // edge
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).toHaveBeenCalledTimes(1);

    await detectIbReconnect(); // steady-connected — no new edge
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).toHaveBeenCalledTimes(1);
  });

  it('re-fires after a disconnect then reconnect', async () => {
    const trig = vi.fn();
    onIbReconnect(fakeHandle(trig));

    mockStatus.mockResolvedValue(up);
    await detectIbReconnect(); // first edge (from the initial false)
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).toHaveBeenCalledTimes(1);

    mockStatus.mockResolvedValue(down);
    await detectIbReconnect(); // drop
    mockStatus.mockResolvedValue(up);
    await detectIbReconnect(); // reconnect edge
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).toHaveBeenCalledTimes(2);
  });

  it('staggers successive triggers', async () => {
    const a = vi.fn();
    const b = vi.fn();
    onIbReconnect(fakeHandle(a));
    onIbReconnect(fakeHandle(b));

    mockStatus.mockResolvedValue(up);
    await detectIbReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(a).toHaveBeenCalledTimes(1); // first fires immediately
    expect(b).not.toHaveBeenCalled(); // second waits a stagger slot
    await vi.advanceTimersByTimeAsync(3000);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('treats a status() rejection as down (no fire)', async () => {
    const trig = vi.fn();
    onIbReconnect(fakeHandle(trig));
    mockStatus.mockRejectedValue(new Error('IB down'));
    await detectIbReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(trig).not.toHaveBeenCalled();
  });
});
