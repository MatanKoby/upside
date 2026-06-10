// universeQuoteProducer — Batch S0.5, extended Batch X4 (daily_bars layer).
//
// Daily producer with two jobs, both off the same Polygon grouped-daily pulls:
//
//   1. universe.last_price / last_volume refresh for every Ring-1 IN ticker
//      (the original S0.5 job) — Polygon grouped-daily (one call → whole US
//      universe) as primary + Yahoo v8/chart per gap as fallback.
//
//   2. daily_bars SSOT (Batch X4) — append the most-recent trading day's bar
//      per universe row (keyed by real_conid), 30-day bootstrap on first run /
//      gaps, ~45-day retention. This is the weekend-safe daily-grain source the
//      curated list / swing pack / sparkline read instead of IB history. After
//      writing bars, recompute universe.last_avg_volume (30d median) in one SQL
//      statement (refresh_universe_avg_volume). See spec/data/sources.md.
//
// Per spec/job-queue.md producer/worker split, Yahoo gap-fills are enqueued as
// `fallback_yahoo_quote` jobs on the `finnhub` worker pool; drained next cycle.
//
// Cadence: 10:00 IDT (= 3 AM ET), after the 09:00 universeCron sweep so new
// universe rows exist before we quote them. Weekend-safe: it targets the most
// recent *weekday* (a Monday run fills Friday's bar), so the curated list
// rebuilds over the weekend with no IB history.

import { notifyError } from '../services/notify.js';
import { polygonGroupedDaily, yahooChart, type DailyOhlcv } from '../services/universeQuote.js';
import { recentWeekdays, buildDailyBarRows } from '../services/dailyBars.js';
import { dailyBarsTableModule } from '../db/dailyBarsTableModule.js';
import { universeTableModule } from '../db/universeTableModule.js';
import { enqueue, drainDone, drainFailed, deleteJob, markRetry, finalizeFailure } from '../services/jobs/queue.js';
import { makeKey } from '../services/jobs/keys.js';
import { finnhubRegistry } from '../services/jobs/actions.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 2;

const DAILY_BARS_LOOKBACK_DAYS = 30; // bootstrap depth (covers ATR(14) + 30d median ADV)
const DAILY_BARS_RETENTION_DAYS = 45; // keep a little slack past the 30d window
const POLYGON_MIN_INTERVAL_MS = 13_000; // free tier is 5 calls/min → ≥12s apart

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Paginated so we get the whole IN universe regardless of the PostgREST
// max-rows cap (the universe is ~3-5k rows).
async function loadRing1Tickers(): Promise<Array<{ symbol: string; realConid: number | null }>> {
  try {
    return await universeTableModule.getInRows();
  } catch (e) {
    void notifyError('universeQuoteProducer.loadUniverse', (e as Error).message);
    return [];
  }
}

async function writeOhlcvToUniverse(
  symbol: string,
  ohlcv: DailyOhlcv,
  nowIso: string,
): Promise<void> {
  try {
    await universeTableModule.setDailyQuoteBySymbol(symbol, ohlcv.close, Math.round(ohlcv.volume), nowIso);
  } catch (e) {
    void notifyError(`universeQuoteProducer.update.${symbol}`, (e as Error).message);
  }
}

// ── daily_bars writes ────────────────────────────────────────────────────────

/** Does daily_bars already hold rows for this trading date? */
async function dateHasBars(date: string): Promise<boolean> {
  try {
    return (await dailyBarsTableModule.countForDate(date)) > 0;
  } catch (e) {
    void notifyError(`universeQuoteProducer.dateHasBars.${date}`, (e as Error).message);
    return true; // assume present on error so we don't hammer Polygon
  }
}

async function writeDailyBars(
  date: string,
  grouped: Record<string, DailyOhlcv>,
  symbolToConid: Map<string, number>,
  nowIso: string,
): Promise<number> {
  const rows = buildDailyBarRows(date, grouped, symbolToConid, 'polygon', nowIso);
  try {
    await dailyBarsTableModule.upsertBars(rows);
  } catch (e) {
    void notifyError(`universeQuoteProducer.dailyBars.upsert.${date}`, (e as Error).message);
  }
  return rows.length;
}

async function retainDailyBars(): Promise<void> {
  const cutoff = new Date(Date.now() - DAILY_BARS_RETENTION_DAYS * 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);
  try {
    await dailyBarsTableModule.purgeOlderThan(cutoff);
  } catch (e) {
    void notifyError('universeQuoteProducer.dailyBars.retention', (e as Error).message);
  }
}

async function refreshAvgVolume(): Promise<void> {
  try {
    await universeTableModule.refreshAvgVolume();
  } catch (e) {
    void notifyError('universeQuoteProducer.refreshAvgVolume', (e as Error).message);
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
  const targetDates = recentWeekdays(DAILY_BARS_LOOKBACK_DAYS); // most recent first
  const primary = targetDates[0];
  console.log(`[universeQuoteProducer] start, primary date=${primary}`);

  const tickers = await loadRing1Tickers();
  if (tickers.length === 0) {
    console.log('[universeQuoteProducer] no Ring-1 IN tickers; nothing to do');
    return;
  }
  const symbolToConid = new Map<string, number>();
  for (const t of tickers) {
    if (t.realConid != null) symbolToConid.set(t.symbol, t.realConid);
  }

  // Which target dates still need a daily_bars fetch (cheap per-date existence
  // check; ~30 tiny count queries).
  const missing: string[] = [];
  for (const d of targetDates) {
    if (!(await dateHasBars(d))) missing.push(d);
  }

  const nowIso = new Date().toISOString();

  // 1. Primary Polygon pull (always — universe.last_price needs it). Reused for
  //    daily_bars when the primary date is missing.
  let primaryMap: Record<string, DailyOhlcv> = {};
  try {
    primaryMap = await polygonGroupedDaily(primary);
  } catch (e) {
    void notifyError('universeQuoteProducer.polygon', (e as Error).message, e);
    // Don't return — drain fallback results from the previous run anyway.
  }

  // universe.last_price / last_volume for matched symbols.
  let written = 0;
  for (const t of tickers) {
    const ohlcv = primaryMap[t.symbol];
    if (!ohlcv) continue;
    await writeOhlcvToUniverse(t.symbol, ohlcv, nowIso);
    written++;
  }
  const gaps = tickers.filter((t) => !primaryMap[t.symbol]);
  console.log(
    `[universeQuoteProducer] polygon hit=${written}/${tickers.length} gaps=${gaps.length}`,
  );

  // 2a. daily_bars for the primary date (reusing the pull above).
  let barRows = 0;
  let barDates = 0;
  if (missing.includes(primary)) {
    barRows += await writeDailyBars(primary, primaryMap, symbolToConid, nowIso);
    barDates++;
  }

  // 2b. daily_bars bootstrap — the remaining missing (older) dates, one
  //     rate-limited Polygon call each. Steady state has zero of these.
  for (const d of missing) {
    if (d === primary) continue;
    await sleep(POLYGON_MIN_INTERVAL_MS);
    let map: Record<string, DailyOhlcv> = {};
    try {
      map = await polygonGroupedDaily(d);
    } catch (e) {
      void notifyError(`universeQuoteProducer.dailyBars.polygon.${d}`, (e as Error).message);
      continue;
    }
    barRows += await writeDailyBars(d, map, symbolToConid, nowIso);
    barDates++;
  }
  if (barDates > 0) {
    console.log(`[universeQuoteProducer] daily_bars: dates=${barDates} rows=${barRows}`);
  }

  // 3. Enqueue Yahoo fallback jobs for the universe-price gaps (conid threaded
  //    so the worker can also drop a daily_bars row for long-tail names).
  let enqueued = 0;
  let deduped = 0;
  for (const t of gaps) {
    const jobKey = makeKey('fallback_yahoo_quote', t.symbol, primary);
    try {
      const r = await enqueue(jobKey, 'fallback_yahoo_quote', 'finnhub', {
        symbol: t.symbol,
        date: primary,
        conid: t.realConid,
      });
      if (r === 'created') enqueued++;
      else deduped++;
    } catch (e) {
      void notifyError(`universeQuoteProducer.enqueue.${t.symbol}`, (e as Error).message);
    }
  }
  console.log(`[universeQuoteProducer] yahoo enqueued=${enqueued} deduped=${deduped}`);

  // 4. Drain previous-cycle yahoo fallback results.
  await drainFallbackResults();

  // 5. Recompute universe.last_avg_volume (30d median) + prune old bars.
  if (barDates > 0) await refreshAvgVolume();
  await retainDailyBars();

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
// fetched OHLCV to the universe row (same as Polygon's path) and, when the
// real_conid is known, a daily_bars row for the primary date.
// ---------------------------------------------------------------------------

interface YahooQuoteJobPayload {
  symbol: string;
  date: string;
  conid?: number | null;
}

finnhubRegistry['fallback_yahoo_quote'] = async (payloadIn) => {
  const payload = payloadIn as unknown as YahooQuoteJobPayload;
  if (!payload.symbol) throw new Error('fallback_yahoo_quote: missing payload.symbol');
  const ohlcv = await yahooChart(payload.symbol);
  if (!ohlcv) {
    throw new Error(`yahoo had no data for ${payload.symbol}`);
  }
  const nowIso = new Date().toISOString();
  await writeOhlcvToUniverse(payload.symbol, ohlcv, nowIso);
  if (payload.conid != null && payload.date) {
    const rows = buildDailyBarRows(
      payload.date,
      { [payload.symbol]: ohlcv },
      new Map([[payload.symbol, payload.conid]]),
      'yahoo',
      nowIso,
    );
    if (rows.length > 0) {
      try {
        await dailyBarsTableModule.upsertBars(rows);
      } catch (e) {
        void notifyError(`universeQuoteProducer.yahooBars.upsert.${payload.symbol}`, (e as Error).message);
      }
    }
  }
};
