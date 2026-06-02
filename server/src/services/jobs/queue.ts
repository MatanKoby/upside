// Producer-facing helpers for the async job queue (Batch S0.3).
//
// Producers (cron schedulers) use these to enqueue deduplicated work and to
// drain completed/failed rows in their cycle. Workers (worker.ts) never
// touch retry policy — that's the producer's job. See spec/job-queue.md.

import { supabase } from '../supabase.js';

export { makeKey } from './keys.js';

export type WorkerPool = 'ib' | 'finnhub' | 'compute';

export type JobStatus = 'queued' | 'claimed' | 'done' | 'failed';

export interface JobRow {
  id: string;
  job_key: string;
  action: string;
  worker_pool: WorkerPool;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  scheduled_for: string;
  claimed_at: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  last_error: string | null;
  // Worker-written output, consumed by the producer during drainDone for
  // multi-stage flows (e.g. catalyst_reversal Stage 1 → Stage 2). Added in
  // migration 025 (Batch S2); empty object for actions that don't use it.
  result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EnqueueOptions {
  priority?: number;
  scheduledFor?: Date;
}

/**
 * Enqueue a job. Calls the `enqueue_job` Postgres function, which runs
 * INSERT … ON CONFLICT DO NOTHING against the partial unique index on
 * job_key (active rows only). Returns 'created' when the row landed,
 * 'deduped' when an active row with the same key already existed.
 */
export async function enqueue(
  jobKey: string,
  action: string,
  workerPool: WorkerPool,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {},
): Promise<'created' | 'deduped'> {
  const { data, error } = await supabase().rpc('enqueue_job', {
    p_job_key: jobKey,
    p_action: action,
    p_worker_pool: workerPool,
    p_payload: payload,
    p_priority: opts.priority ?? 0,
    p_scheduled_for: (opts.scheduledFor ?? new Date()).toISOString(),
  });
  if (error) throw new Error(`enqueue_job failed: ${error.message}`);
  return (data === 'created' ? 'created' : 'deduped');
}

/**
 * Return all `done` rows for an action so the producer can act on results
 * (typically: write the result onto the target table — though workers
 * usually do that themselves before marking done — then delete the row).
 */
export async function drainDone(action: string): Promise<JobRow[]> {
  const { data, error } = await supabase()
    .from('screener_jobs')
    .select('*')
    .eq('action', action)
    .eq('status', 'done')
    .limit(1000);
  if (error) throw new Error(`drainDone(${action}) failed: ${error.message}`);
  return (data ?? []) as JobRow[];
}

/**
 * Return all `failed` rows for an action so the producer can apply its
 * retry policy. The worker never re-queues — only producers do.
 */
export async function drainFailed(action: string): Promise<JobRow[]> {
  const { data, error } = await supabase()
    .from('screener_jobs')
    .select('*')
    .eq('action', action)
    .eq('status', 'failed')
    .limit(1000);
  if (error) throw new Error(`drainFailed(${action}) failed: ${error.message}`);
  return (data ?? []) as JobRow[];
}

/**
 * Hard-delete a job row. Producer calls this after acting on a `done` or
 * a finalized-loss `failed` row.
 */
export async function deleteJob(id: string): Promise<void> {
  const { error } = await supabase().from('screener_jobs').delete().eq('id', id);
  if (error) throw new Error(`deleteJob(${id}) failed: ${error.message}`);
}

/**
 * Producer-initiated retry: insert a fresh queued row with the same
 * job_key (the failed row is outside the partial unique index, so the
 * insert succeeds) and delete the old failed row. Race-safe: if two
 * concurrent retry attempts run, the second's insert returns 'deduped'
 * because the first's row is already 'queued' inside the index.
 */
export async function markRetry(failed: JobRow): Promise<'queued' | 'deduped'> {
  const result = await enqueue(
    failed.job_key,
    failed.action,
    failed.worker_pool,
    failed.payload,
    { priority: failed.priority, scheduledFor: new Date(failed.scheduled_for) },
  );
  // Delete the failed row whether we re-queued or deduped — either way
  // its purpose (signaling failure to producer) is served.
  await deleteJob(failed.id);
  return result === 'created' ? 'queued' : 'deduped';
}

/**
 * Producer-initiated finalization for an unrecoverable failed job. Just
 * deletes the row; caller is expected to fire a Discord notification
 * separately if it wants observability.
 */
export async function finalizeFailure(failed: JobRow): Promise<void> {
  await deleteJob(failed.id);
}

/**
 * Worker-facing — marks the in-flight job as `done`. Worker calls this
 * after writing the result onto the target table. The optional `result`
 * payload is for multi-stage flows where the producer needs the worker's
 * computed value to decide the next step (catalyst_reversal Stage 1 → 2);
 * single-stage actions can omit it.
 */
export async function markDone(
  id: string,
  result: Record<string, unknown> | null = null,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: 'done',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (result != null) patch.result = result;
  const { error } = await supabase().from('screener_jobs').update(patch).eq('id', id);
  if (error) throw new Error(`markDone(${id}) failed: ${error.message}`);
}

/**
 * Worker-facing — marks the in-flight job as `failed`. Worker never
 * decides retry; the producer's drainFailed → markRetry path handles it.
 */
export async function markFailed(id: string, errorMessage: string, attempts: number): Promise<void> {
  const { error } = await supabase()
    .from('screener_jobs')
    .update({
      status: 'failed',
      last_error: errorMessage.slice(0, 2000),
      attempts: attempts + 1,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`markFailed(${id}) failed: ${error.message}`);
}

/**
 * Worker-facing — atomic claim of the next eligible job. Calls
 * claim_next_job() which runs SELECT FOR UPDATE SKIP LOCKED inside a
 * txn, so two workers polling at the same instant cannot double-claim.
 * Returns null when no job is available.
 */
export async function claimNext(
  workerPool: WorkerPool,
  workerId: string,
  leaseSeconds = 300,
): Promise<JobRow | null> {
  const { data, error } = await supabase().rpc('claim_next_job', {
    p_worker_pool: workerPool,
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`claim_next_job failed: ${error.message}`);
  // RPC of a function returning a single composite row gives back the row
  // directly (not an array). null when no eligible job.
  return (data && (data as JobRow).id) ? (data as JobRow) : null;
}
