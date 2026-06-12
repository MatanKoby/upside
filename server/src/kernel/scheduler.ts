// kernel/scheduler.ts — the one cron primitive (Batch ARCH-9, Phase 3).
//
// Every cron is the same shape: wait an optional first-run delay, then on each
// tick check a list of gates and — if all pass — run the body, recording any
// uncaught throw to Discord; schedule the next tick only after this one settles.
//
// Why a single recursive setTimeout rather than setInterval: scheduling the next
// tick in the `finally` (after the body's await resolves) makes the loop
// single-flight by construction — a body that runs longer than `intervalMs` can
// never overlap itself. That recursive loop *is* the lock; there is deliberately
// no cross-instance lock because we run one api instance (a `lock` knob would
// imply a guarantee we don't provide — see docs/arch/target-architecture.md →
// Phase 3). Gates are the uniform "skip this tick" seam — IB-auth, market-hours,
// and future data-freshness preconditions — and live in cron/gates.ts so this
// kernel stays vendor-agnostic. They are *distinct* from the job queue's
// per-action preconditions (services/jobs/gates.ts), which gate jobs, not crons.

import { notifyError } from '../services/notify.js';

/** A precondition checked before each tick; return false to skip the tick. */
export type Gate = () => boolean | Promise<boolean>;

export interface CronDef {
  /** Log tag + notify key base — an uncaught throw notifies `${name}.tick`. */
  name: string;
  intervalMs: number;
  /** Delay before the first tick (default 0). Preserves each cron's warmup. */
  firstRunDelayMs?: number;
  /** AND-composed — every gate must pass or the tick is skipped silently. */
  gates?: Gate[];
  run: () => Promise<void>;
}

export interface CronHandle {
  start(): void;
  stop(): void;
}

async function allPass(gates: Gate[] | undefined): Promise<boolean> {
  if (!gates) return true;
  for (const gate of gates) {
    if (!(await gate())) return false;
  }
  return true;
}

export function defineCron(def: CronDef): CronHandle {
  let timer: NodeJS.Timeout | null = null;
  let started = false;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(loop, delayMs);
    timer.unref();
  };

  async function loop(): Promise<void> {
    try {
      if (await allPass(def.gates)) await def.run();
    } catch (e) {
      void notifyError(`${def.name}.tick`, (e as Error).message ?? 'unknown', e);
    } finally {
      // Single-flight: the next tick is scheduled only after this one settles.
      if (started) schedule(def.intervalMs);
    }
  }

  return {
    start(): void {
      if (started) return; // idempotent — a second start must not double-schedule
      started = true;
      schedule(def.firstRunDelayMs ?? 0);
    },
    stop(): void {
      started = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
