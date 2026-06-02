// Action registry for the job-queue worker (Batch S0.3).
//
// Each action a worker pool can handle gets a typed handler here. Downstream
// batches (S0.5, S1.5, S2, S3) register their real handlers by adding to
// the relevant pool's section. S0.3 ships only the two `noop:*`
// placeholders used by the framework smoke tests + integration verification.

import type { JobRow, WorkerPool } from './queue.js';

/** Handler signature: takes the job payload, returns when done. Throws on
 *  failure — the framework catches + marks the job failed. Optionally
 *  returns a `result` object that the framework persists on the job row
 *  for the producer's drainDone step to consume (multi-stage flows). */
export type JobHandler = (
  payload: Record<string, unknown>,
  job: JobRow,
) => Promise<void | Record<string, unknown>>;

/** Per-pool action registry. The worker dispatches by action name. */
export type ActionRegistry = Record<string, JobHandler>;

/** noop placeholders for the framework smoke test (see vitest +
 *  README verification steps in BUILD_QUEUE.md → S0.3). */
const noopRegistry: ActionRegistry = {
  'noop:ok': async () => {
    // Always succeeds. Used by the framework smoke test to verify the
    // happy path: enqueue → claim → execute → done → drainDone → delete.
    return;
  },
  'noop:fail': async () => {
    // Always throws. Used by the framework smoke test to verify the
    // failure path: enqueue → claim → execute → catch → failed →
    // drainFailed → producer retry / finalize.
    throw new Error('noop:fail: intentional failure for smoke test');
  },
};

// Each worker pool gets its own registry so an `ib` worker never picks up
// a `compute` job by accident (the queue's `worker_pool` column filters
// the claim query, but the action map gates execution too as a defense in
// depth).
//
// Downstream batches mutate these by importing the relevant registry and
// adding their action handlers — keeps the registry colocated with the
// action's owning batch's code.
export const ibRegistry:      ActionRegistry = { ...noopRegistry };
export const finnhubRegistry: ActionRegistry = { ...noopRegistry };
export const computeRegistry: ActionRegistry = { ...noopRegistry };

export function registryFor(pool: WorkerPool): ActionRegistry {
  switch (pool) {
    case 'ib':      return ibRegistry;
    case 'finnhub': return finnhubRegistry;
    case 'compute': return computeRegistry;
  }
}
