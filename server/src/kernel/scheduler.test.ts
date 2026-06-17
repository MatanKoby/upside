// defineCron tests (Batch ARCH-9) — drive the loop on fake timers and assert
// the four guarantees the ~24 crons lean on: first-run delay + cadence, gate
// AND-skip, single-flight (no overlap), and `${name}.tick` notify-on-throw that
// keeps looping. start/stop idempotency rounds it out.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/notify.js', () => ({ notifyError: vi.fn() }));

import { defineCron } from './scheduler.js';
import { notifyError } from '../services/notify.js';

const mockNotify = notifyError as unknown as ReturnType<typeof vi.fn>;

describe('defineCron', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockNotify.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first tick after firstRunDelayMs, then every intervalMs', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 1000, firstRunDelayMs: 500, run });
    cron.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(4);
    cron.stop();
  });

  it('defaults firstRunDelayMs to 0', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 1000, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    cron.stop();
  });

  it('is single-flight — a slow run never overlaps itself', async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const run = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active--;
    });
    const cron = defineCron({ name: 'c', intervalMs: 100, firstRunDelayMs: 10, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(10); // first tick starts, then blocks
    await vi.advanceTimersByTimeAsync(500); // 5 intervals elapse while it is blocked
    expect(run).toHaveBeenCalledTimes(1); // no second tick was scheduled
    release();
    await vi.advanceTimersByTimeAsync(100); // next tick fires only after the first settled
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    cron.stop();
    release();
  });

  it('skips the tick when any gate returns false (AND semantics)', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const gateTrue = vi.fn().mockResolvedValue(true);
    const gateFalse = vi.fn().mockResolvedValue(false);
    const cron = defineCron({
      name: 'c', intervalMs: 100, firstRunDelayMs: 10, gates: [gateTrue, gateFalse], run,
    });
    cron.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(gateTrue).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    cron.stop();
  });

  it('runs when all gates pass', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({
      name: 'c', intervalMs: 100, firstRunDelayMs: 10, gates: [() => true, async () => true], run,
    });
    cron.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    cron.stop();
  });

  it('notifies `${name}.tick` when run throws, and keeps looping', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    const cron = defineCron({ name: 'myCron', intervalMs: 100, firstRunDelayMs: 10, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockNotify).toHaveBeenCalledWith('myCron.tick', 'boom', expect.any(Error));
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2); // loop survived the throw
    cron.stop();
  });

  it('stop() halts the loop', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 100, firstRunDelayMs: 10, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(1);
    cron.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1); // no further ticks
  });

  it('start() is idempotent', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 100, firstRunDelayMs: 50, run });
    cron.start();
    cron.start(); // second start must not double-schedule
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    cron.stop();
  });

  // trigger() — the IB-reconnect catch-up seam (Batch ARCH-10).
  it('trigger() runs the body once, now — before the first scheduled tick', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 1000, firstRunDelayMs: 1000, run });
    cron.start();
    cron.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1); // fired immediately, not after firstRunDelay
    cron.stop();
  });

  it('trigger() does not disturb the periodic cadence', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 1000, firstRunDelayMs: 1000, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(500); // halfway to the first tick
    cron.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1); // the trigger ran
    await vi.advanceTimersByTimeAsync(500); // reach firstRunDelay — timer was NOT reset
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3); // cadence continues on its original clock
    cron.stop();
  });

  it('trigger() respects gates (skips when a gate is false)', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const cron = defineCron({ name: 'c', intervalMs: 1000, firstRunDelayMs: 1000, gates: [() => false], run });
    cron.start();
    cron.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    cron.stop();
  });

  it('trigger() is a no-op while a tick is in flight (single-flight)', async () => {
    let active = 0;
    let maxActive = 0;
    let release: () => void = () => {};
    const run = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => {
        release = r;
      });
      active--;
    });
    const cron = defineCron({ name: 'c', intervalMs: 1000, firstRunDelayMs: 10, run });
    cron.start();
    await vi.advanceTimersByTimeAsync(10); // first tick starts, then blocks
    cron.trigger();
    cron.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1); // both triggers were no-ops — the in-flight body covers them
    expect(maxActive).toBe(1);
    release();
    cron.stop();
    release();
  });
});
