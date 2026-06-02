// conidResolutionProducer — Batch S1.5.
//
// Daily producer + `ib`-pool worker action that resolves real IBKR
// conids for universe rows where `real_conid IS NULL`. Initial backlog
// (~3,000 rows after S1) takes ~10 min IB at sustainable secdef pacing;
// steady-state is near-zero (~few new symbols/week).
//
// Producer/worker split per spec/job-queue.md:
//   - Producer scans universe → enqueues `resolve_conid` jobs.
//   - Worker (on `ib` pool, gated on IB connection) executes resolveConid,
//     writes real_conid to the universe row, marks done.
//   - Failed jobs: producer retries up to 2 attempts (covers transient
//     IB hiccups); finalizes the failure beyond that (symbol genuinely
//     unresolvable — likely delisted or no US STK listing).

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { resolveConid } from '../services/screener/conidResolver.js';
import {
  enqueue,
  drainDone,
  drainFailed,
  deleteJob,
  markRetry,
  finalizeFailure,
} from '../services/jobs/queue.js';
import { makeKey } from '../services/jobs/keys.js';
import { ibRegistry } from '../services/jobs/actions.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 2;
const ENQUEUE_BATCH_LIMIT = 5000;  // safety cap on a single tick's enqueue volume

interface PendingRow {
  conid: number;
  symbol: string;
  mic: string | null;
}

async function loadPendingRows(): Promise<PendingRow[]> {
  const { data, error } = await supabase()
    .from('universe')
    .select('conid, symbol, mic')
    .eq('filter_result', 'in')
    .is('real_conid', null)
    .limit(ENQUEUE_BATCH_LIMIT);
  if (error) {
    void notifyError('conidResolutionProducer.loadPending', error.message);
    return [];
  }
  return (data ?? []) as PendingRow[];
}

async function drainResults(): Promise<void> {
  const doneRows = await drainDone('resolve_conid').catch((e: Error) => {
    void notifyError('conidResolutionProducer.drainDone', e.message);
    return [];
  });
  for (const j of doneRows) {
    await deleteJob(j.id).catch((e: Error) =>
      notifyError('conidResolutionProducer.deleteDone', e.message),
    );
  }

  const failedRows = await drainFailed('resolve_conid').catch((e: Error) => {
    void notifyError('conidResolutionProducer.drainFailed', e.message);
    return [];
  });
  let retried = 0;
  let finalized = 0;
  for (const j of failedRows) {
    if (j.attempts < MAX_RETRY_ATTEMPTS) {
      await markRetry(j).catch(() => undefined);
      retried++;
    } else {
      await finalizeFailure(j).catch(() => undefined);
      finalized++;
    }
  }
  if (doneRows.length + retried + finalized > 0) {
    console.log(
      `[conidResolutionProducer] drain: done=${doneRows.length} retry=${retried} give-up=${finalized}`,
    );
  }
}

async function tick(): Promise<void> {
  const t0 = Date.now();
  const pending = await loadPendingRows();

  // 1. Enqueue resolve_conid jobs for rows needing resolution.
  let enqueued = 0;
  let deduped = 0;
  for (const row of pending) {
    const jobKey = makeKey('resolve_conid', row.symbol, row.mic ?? '');
    try {
      const r = await enqueue(jobKey, 'resolve_conid', 'ib', {
        universeConid: row.conid,  // synthetic PK; worker UPDATEs by this
        symbol: row.symbol,
        mic: row.mic,
      });
      if (r === 'created') enqueued++;
      else deduped++;
    } catch (e) {
      void notifyError(`conidResolutionProducer.enqueue.${row.symbol}`, (e as Error).message);
    }
  }
  if (pending.length > 0 || enqueued > 0) {
    console.log(
      `[conidResolutionProducer] pending=${pending.length} enqueued=${enqueued} deduped=${deduped} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  }

  // 2. Drain prior cycle's done/failed jobs.
  await drainResults();
}

export function startConidResolutionProducer(): void {
  console.log('[conidResolutionProducer] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('conidResolutionProducer.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}

// ---------------------------------------------------------------------------
// Worker-side action handler — registered on the `ib` pool. Pool gating
// (ibStatus check) is enforced by createIbWorker(); handler can assume IB
// is reachable at execution time. If the secdef call fails at the IB
// layer, the framework catches the throw and marks failed.
// ---------------------------------------------------------------------------

interface ResolveConidJobPayload {
  universeConid: number;
  symbol: string;
  mic: string | null;
}

ibRegistry['resolve_conid'] = async (payloadIn) => {
  const payload = payloadIn as unknown as ResolveConidJobPayload;
  if (!payload.symbol) throw new Error('resolve_conid: missing payload.symbol');
  const result = await resolveConid(payload.symbol);
  if (!result) {
    // IB responded fine but no US STK match (genuinely unresolvable, e.g.
    // delisted-since-Finnhub-pull, foreign-only listing). Throw so the
    // framework marks failed; producer's retry budget eventually finalizes.
    throw new Error(`resolve_conid: no US STK match for ${payload.symbol}`);
  }
  const { error } = await supabase()
    .from('universe')
    .update({ real_conid: result.conid })
    .eq('conid', payload.universeConid);
  if (error) {
    throw new Error(`resolve_conid: universe update failed for ${payload.symbol}: ${error.message}`);
  }
};
