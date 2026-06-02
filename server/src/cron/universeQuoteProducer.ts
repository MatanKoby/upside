// universeQuoteProducer — Batch S0.5.
//
// Daily producer that refreshes `universe.last_price` + `universe.last_volume`
// for every Ring-1 IN ticker, using Polygon grouped-daily-bars (one call →
// whole US universe) as primary + Yahoo v8/chart per gap as fallback.
//
// Per spec/job-queue.md producer/worker split:
//   - Polygon call is producer-side direct work (one shot, cheap, no
//     queue benefit).
//   - Yahoo gap-fills are enqueued as `fallback_yahoo_quote` jobs on the
//     `finnhub` worker pool (any HTTP-rate-limited pool would do; we
//     reuse `finnhub` since it has the right gating semantics).
//   - Drain completed `fallback_yahoo_quote` jobs at end of cycle, write
//     results to universe rows, delete the job rows.
//   - Failed gap-fills: producer's retry policy is "give up after 2
//     attempts" — Yahoo data on a ticker missing from Polygon is
//     low-value; not worth chasing for days.
//
// Cadence: 10:00 IDT (= 3 AM ET), after the 09:00 universeCron sweep so
// new universe rows exist before we try to quote them.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { polygonGroupedDaily, yahooChart, type DailyOhlcv } from '../services/universeQuote.js';
import { enqueue, drainDone, drainFailed, deleteJob, markRetry, finalizeFailure } from '../services/jobs/queue.js';
import { makeKey } from '../services/jobs/keys.js';
import { finnhubRegistry } from '../services/jobs/actions.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 2;

// Pick the most recent COMPLETED trading day in YYYY-MM-DD form. Polygon
// updates grouped-daily-bars for a date after the day's session closes
// (~5 PM ET); to be safe we ask for "yesterday" which is reliably closed
// regardless of when in IDT-time the cron runs.
function yesterdayUtcDate(): string {
  const d = new Date(Date.now() - 24 * 60 * 60_000);
  return d.toISOString().slice(0, 10);
}

interface UniverseRow {
  conid: number;
  symbol: string;
}

async function loadRing1Tickers(): Promise<UniverseRow[]> {
  const { data, error } = await supabase()
    .from('universe')
    .select('conid, symbol')
    .eq('filter_result', 'in');
  if (error) {
    void notifyError('universeQuoteProducer.loadUniverse', error.message);
    return [];
  }
  return (data ?? []) as UniverseRow[];
}

async function writeOhlcvToUniverse(
  symbol: string,
  ohlcv: DailyOhlcv,
  nowIso: string,
): Promise<void> {
  const { error } = await supabase()
    .from('universe')
    .update({
      last_price: ohlcv.close,
      last_volume: Math.round(ohlcv.volume),
      computed_at: nowIso,
    })
    .eq('symbol', symbol);
  if (error) {
    void notifyError(`universeQuoteProducer.update.${symbol}`, error.message);
  }
}

async function drainFallbackResults(): Promise<{ done: number; failed: number }> {
  const doneRows = await drainDone('fallback_yahoo_quote').catch((e: Error) => {
    void notifyError('universeQuoteProducer.drainDone', e.message);
    return [];
  });
  for (const j of doneRows) {
    // Worker has already written the OHLCV to the universe row; producer
    // just deletes the completed job row to keep the queue clean.
    await deleteJob(j.id).catch((e: Error) =>
      notifyError('universeQuoteProducer.deleteDone', e.message),
    );
  }

  const failedRows = await drainFailed('fallback_yahoo_quote').catch((e: Error) => {
    void notifyError('universeQuoteProducer.drainFailed', e.message);
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
  if (retried > 0 || finalized > 0) {
    console.log(
      `[universeQuoteProducer] fallback drain: done=${doneRows.length} retry=${retried} give-up=${finalized}`,
    );
  }
  return { done: doneRows.length, failed: failedRows.length };
}

async function tick(): Promise<void> {
  if (!process.env.POLYGON_API_KEY) {
    console.log('[universeQuoteProducer] POLYGON_API_KEY not set — skipping');
    return;
  }
  const t0 = Date.now();
  const date = yesterdayUtcDate();
  console.log(`[universeQuoteProducer] start, target date=${date}`);

  const tickers = await loadRing1Tickers();
  if (tickers.length === 0) {
    console.log('[universeQuoteProducer] no Ring-1 IN tickers; nothing to do');
    return;
  }

  // 1. Polygon primary: one call, write all matched tickers directly.
  let polygonMap: Record<string, DailyOhlcv> = {};
  try {
    polygonMap = await polygonGroupedDaily(date);
  } catch (e) {
    void notifyError('universeQuoteProducer.polygon', (e as Error).message, e);
    // Don't return — drain fallback results from previous run anyway.
  }
  const nowIso = new Date().toISOString();
  let written = 0;
  for (const t of tickers) {
    const ohlcv = polygonMap[t.symbol];
    if (!ohlcv) continue;
    await writeOhlcvToUniverse(t.symbol, ohlcv, nowIso);
    written++;
  }
  const gaps = tickers.filter((t) => !polygonMap[t.symbol]);
  console.log(
    `[universeQuoteProducer] polygon hit=${written}/${tickers.length} gaps=${gaps.length}`,
  );

  // 2. Enqueue Yahoo fallback jobs for the gaps.
  let enqueued = 0;
  let deduped = 0;
  for (const t of gaps) {
    const jobKey = makeKey('fallback_yahoo_quote', t.symbol, date);
    try {
      // queue.ts enqueue signature: (jobKey, action, workerPool, payload, opts)
      const r = await enqueue(jobKey, 'fallback_yahoo_quote', 'finnhub', {
        symbol: t.symbol,
        date,
      });
      if (r === 'created') enqueued++;
      else deduped++;
    } catch (e) {
      void notifyError(`universeQuoteProducer.enqueue.${t.symbol}`, (e as Error).message);
    }
  }
  console.log(`[universeQuoteProducer] yahoo enqueued=${enqueued} deduped=${deduped}`);

  // 3. Drain previous-cycle yahoo fallback results.
  await drainFallbackResults();

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[universeQuoteProducer] done in ${elapsedSec}s`);
}

export function startUniverseQuoteProducer(): void {
  console.log('[universeQuoteProducer] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('universeQuoteProducer.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}

// ---------------------------------------------------------------------------
// Worker-side action handler — registered on the finnhub pool so it
// inherits the existing HTTP-pool gating. The producer enqueues per-gap
// `fallback_yahoo_quote` jobs; the worker pulls them and writes the
// fetched OHLCV directly to the universe row (same as Polygon's path).
// ---------------------------------------------------------------------------

interface YahooQuoteJobPayload {
  symbol: string;
  date: string;
}

finnhubRegistry['fallback_yahoo_quote'] = async (payloadIn) => {
  const payload = payloadIn as unknown as YahooQuoteJobPayload;
  if (!payload.symbol) throw new Error('fallback_yahoo_quote: missing payload.symbol');
  const ohlcv = await yahooChart(payload.symbol);
  if (!ohlcv) {
    throw new Error(`yahoo had no data for ${payload.symbol}`);
  }
  await writeOhlcvToUniverse(payload.symbol, ohlcv, new Date().toISOString());
};
