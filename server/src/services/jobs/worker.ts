// Worker-pool runtime for the async job queue (Batch S0.3).
//
// A worker is a setTimeout loop that pulls one job at a time from its
// pool, executes the action handler registered for the action name, and
// marks the outcome (done | failed). Producer logic (retry policy, gating)
// lives elsewhere — workers are pure executors per spec/job-queue.md.
//
// Pool-level gating (`poolGateOk`) decides whether to attempt a claim at
// all this tick — e.g. the `ib` pool skips claim attempts when IB is
// disconnected so we don't burn DB round-trips.

import { hostname } from 'node:os';
import {
  claimNext,
  deferJob,
  markDone,
  markFailed,
  type JobRow,
  type WorkerPool,
} from './queue.js';
import { registryFor, type ActionRegistry } from './actions.js';
import { gateRegistry, type GateResult } from './gates.js';
import { notifyError, notifyCritical } from '../notify.js';

export interface WorkerOptions {
  pool: WorkerPool;
  /** Returns true when the pool is "open" — i.e. attempts to claim should
   *  proceed. The framework calls this once before each claim attempt. */
  poolGateOk: () => Promise<boolean> | boolean;
  /** Sleep interval when the gate is closed OR no jobs available. */
  idleMs?: number;
  /** Lease duration in seconds; reaper flips claimed→failed past this. */
  leaseSeconds?: number;
  /** Per-action registry override (defaults to registryFor(pool)). */
  registry?: ActionRegistry;
}

interface CircuitState {
  failures: Array<number>; // unix-ms timestamps
  triggered: boolean;
}

// Circuit breaker — fires `notifyCritical` once per action when ≥10 failures
// land within a 5-minute window. Avoids alert spam when an action is
// broken; the producer's retry policy still applies on top.
const CIRCUIT_WINDOW_MS = 5 * 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 10;
const circuitByAction = new Map<string, CircuitState>();

function recordFailureAndCheckCircuit(action: string): boolean {
  const now = Date.now();
  let s = circuitByAction.get(action);
  if (!s) {
    s = { failures: [], triggered: false };
    circuitByAction.set(action, s);
  }
  s.failures = s.failures.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  s.failures.push(now);
  if (s.failures.length >= CIRCUIT_FAILURE_THRESHOLD && !s.triggered) {
    s.triggered = true;
    return true;
  }
  // Reset trigger once window clears below threshold so the next breach
  // notifies again.
  if (s.triggered && s.failures.length < CIRCUIT_FAILURE_THRESHOLD) {
    s.triggered = false;
  }
  return false;
}

export interface Worker {
  start(): void;
  stop(): void;
}

export function createWorker(opts: WorkerOptions): Worker {
  const pool = opts.pool;
  const idleMs = opts.idleMs ?? 5000;
  const leaseSeconds = opts.leaseSeconds ?? 300;
  const registry = opts.registry ?? registryFor(pool);
  const workerId = `${pool}-${process.pid}-${hostname()}`;

  let stopped = false;
  let pending: ReturnType<typeof setTimeout> | null = null;

  async function processOne(): Promise<'busy' | 'idle' | 'gate-closed'> {
    let gateOk: boolean;
    try {
      gateOk = await opts.poolGateOk();
    } catch (e) {
      void notifyError(`jobs.${pool}.gate`, (e as Error).message, e);
      return 'gate-closed';
    }
    if (!gateOk) return 'gate-closed';

    let job: JobRow | null;
    try {
      job = await claimNext(pool, workerId, leaseSeconds);
    } catch (e) {
      void notifyError(`jobs.${pool}.claim`, (e as Error).message, e);
      return 'idle';
    }
    if (!job) return 'idle';

    const handler = registry[job.action];
    if (!handler) {
      const msg = `no handler registered for action '${job.action}' in pool '${pool}'`;
      try {
        await markFailed(job.id, msg, job.attempts);
      } catch (e) {
        void notifyError(`jobs.${pool}.markFailed`, (e as Error).message, e);
      }
      if (recordFailureAndCheckCircuit(job.action)) {
        void notifyCritical(
          `jobs.circuit.${job.action}`,
          `Job-queue circuit tripped for action '${job.action}' (≥${CIRCUIT_FAILURE_THRESHOLD} failures in ${CIRCUIT_WINDOW_MS / 60_000}m)`,
        );
      }
      return 'busy';
    }

    // Per-action gate (Batch X10): a mechanical "can this run now?" check,
    // evaluated post-claim / pre-execute. On not-ready we DEFER (reschedule,
    // attempts unchanged) rather than execute-and-fail. A gate that throws is
    // a bug in the (pure) predicate, not a reason to block work — log it and
    // fall through to execute (degrades to the pre-gate behaviour).
    const gate = gateRegistry[job.action];
    if (gate) {
      let g: GateResult | null = null;
      try {
        g = await gate(job.payload, job);
      } catch (e) {
        void notifyError(`jobs.${pool}.gate.${job.action}`, (e as Error).message, e);
      }
      if (g && !g.ready) {
        const retryAt = g.retryAt ?? new Date(Date.now() + 5 * 60_000);
        try {
          await deferJob(job.id, retryAt);
          console.log(
            `[jobs/${pool}] deferred ${job.action} (${job.job_key}) → ${retryAt.toISOString()}`,
          );
        } catch (e) {
          void notifyError(`jobs.${pool}.defer`, (e as Error).message, e);
        }
        return 'busy';
      }
    }

    try {
      const result = await handler(job.payload, job);
      try {
        await markDone(job.id, result ?? null);
      } catch (e) {
        void notifyError(`jobs.${pool}.markDone`, (e as Error).message, e);
      }
    } catch (e) {
      const errMsg = (e as Error).message ?? String(e);
      try {
        await markFailed(job.id, errMsg, job.attempts);
      } catch (e2) {
        void notifyError(`jobs.${pool}.markFailed`, (e2 as Error).message, e2);
      }
      if (recordFailureAndCheckCircuit(job.action)) {
        void notifyCritical(
          `jobs.circuit.${job.action}`,
          `Job-queue circuit tripped for action '${job.action}' (≥${CIRCUIT_FAILURE_THRESHOLD} failures in ${CIRCUIT_WINDOW_MS / 60_000}m) — last error: ${errMsg.slice(0, 200)}`,
          e,
        );
      }
    }
    return 'busy';
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    let nextDelayMs = idleMs;
    try {
      const outcome = await processOne();
      if (outcome === 'busy') {
        // Drain as fast as the DB will let us when work is available.
        nextDelayMs = 0;
      }
    } catch (e) {
      void notifyError(`jobs.${pool}.tick`, (e as Error).message, e);
    } finally {
      if (!stopped) {
        pending = setTimeout(tick, nextDelayMs);
        pending.unref?.();
      }
    }
  }

  return {
    start(): void {
      if (pending) return;
      console.log(`[jobs/${pool}] worker starting (id=${workerId})`);
      pending = setTimeout(tick, 0);
      pending.unref?.();
    },
    stop(): void {
      stopped = true;
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    },
  };
}

// Convenience factories for the three standard pools. Boot wiring in
// index.ts just calls these — gating predicates live colocated here.
import { ibGateway } from '../../adapters/ib/ibGatewayAdapter.js';

export function createIbWorker(): Worker {
  return createWorker({
    pool: 'ib',
    poolGateOk: async () => {
      const s = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
      return Boolean(s.authenticated && s.connected);
    },
  });
}

export function createFinnhubWorker(): Worker {
  return createWorker({
    pool: 'finnhub',
    // finnhubQueue is the per-call rate limiter inside Finnhub handlers
    // themselves — the pool gate is just "always open" because the
    // limiter handles backpressure inline.
    poolGateOk: () => true,
  });
}

export function createComputeWorker(): Worker {
  return createWorker({
    pool: 'compute',
    poolGateOk: () => true,
  });
}
