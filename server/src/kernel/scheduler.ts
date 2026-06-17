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
  /**
   * Run the body once *now* — through the same gates + single-flight as a
   * periodic tick — without disturbing the cadence timer. A no-op if a tick is
   * already in flight. The IB-reconnect catch-up calls this (see
   * `cron/ibReconnect.ts`) so a stale feed rebuilds the moment IB returns
   * instead of waiting out its 12–24h cadence.
   */
  trigger(): void;
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
  let running = false; // one body at a time — the periodic loop ∥ trigger()

  const schedule = (delayMs: number): void => {
    timer = setTimeout(loop, delayMs);
    timer.unref();
  };

  // One gated, error-trapped run of the body. The `running` guard makes the
  // body single-flight across BOTH the periodic loop and an off-cadence
  // trigger(): if one is mid-flight the other is a no-op — the in-flight run
  // already covers this tick.
  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (await allPass(def.gates)) await def.run();
    } catch (e) {
      void notifyError(`${def.name}.tick`, (e as Error).message ?? 'unknown', e);
    } finally {
      running = false;
    }
  }

  async function loop(): Promise<void> {
    await runOnce();
    // The next tick is scheduled only after this one settles — keeps the
    // periodic cadence single-flight even if a body runs longer than intervalMs.
    if (started) schedule(def.intervalMs);
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
    trigger(): void {
      void runOnce(); // run now, gated + single-flight; leaves the timer alone
    },
  };
}
