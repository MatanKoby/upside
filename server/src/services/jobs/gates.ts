// Per-action preconditions ("gates") for the job-queue worker (Batch X10).
//
// The pool gate (worker.ts → poolGateOk) is coarse: "is this upstream
// available at all?" A gate is finer — a mechanical "can this action run
// *right now*?" predicate the pool can't express. The worker evaluates the
// gate AFTER claim, BEFORE execute; on not-ready it DEFERS (reschedules,
// attempts NOT incremented) rather than failing. See spec/job-queue.md →
// Per-action preconditions (gates).
//
// Motivating case: `eval_catalyst_stage1` needs a live RTH snapshot — IBKR
// field 7295 (today's open) only exists after 09:30 ET, and ibHistory 503s
// off-hours — so catalyst jobs claimed overnight used to fail and burn retry
// attempts. With `requiresRthOpen` they defer to the next 09:30 ET instead.
//
// A gate is mechanical, not business logic: it never decides whether the work
// is *relevant* (the producer's job), only whether its preconditions are *met*.

import type { JobRow } from './queue.js';
import { marketPeriodAt, nextRegularOpenEtIso } from '../../utils/marketHours.js';

export interface GateResult {
  ready: boolean;
  /** When `ready` is false, when to re-attempt. The worker reschedules the job
   *  to this instant without incrementing `attempts`. */
  retryAt?: Date;
}

export type Gate = (
  payload: Record<string, unknown>,
  job: JobRow,
) => GateResult | Promise<GateResult>;

/** action name → gate. Populated alongside the action handler (e.g. the
 *  catalyst producer registers both). The worker looks the action up here
 *  after claiming; absent = no gate (always ready). */
export const gateRegistry: Record<string, Gate> = {};

/**
 * Ready only inside the regular cash session (09:30–16:00 ET, trading days).
 * Off-hours / weekends / holidays defer to the next regular open. `clock` is
 * injectable for tests.
 */
export function requiresRthOpen(clock: () => Date = () => new Date()): Gate {
  return () => {
    const now = clock();
    if (marketPeriodAt(now) === 'regular') return { ready: true };
    return { ready: false, retryAt: new Date(nextRegularOpenEtIso(now)) };
  };
}

/**
 * Ready in any active session (pre-market / regular / after-hours). Only the
 * fully-closed state defers — conservatively to the next regular open (we
 * don't model the next pre-market open in v1; bump to a pre-market resolver
 * if an action ever needs the AH/PM window precisely).
 */
export function requiresMarketOpen(clock: () => Date = () => new Date()): Gate {
  return () => {
    const now = clock();
    if (marketPeriodAt(now) !== 'closed') return { ready: true };
    return { ready: false, retryAt: new Date(nextRegularOpenEtIso(now)) };
  };
}
