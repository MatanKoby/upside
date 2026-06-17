// postEarningsDriftProducer — Batch S2.
//
// Daily producer for the post_earnings_drift trait. One Finnhub call
// covers the candidate set; per-reporter IB history calls land on the
// `ib` worker pool via `eval_post_earnings_drift` jobs.
//
// Flow per spec/signals/screener-universe.md → post_earnings_drift:
//   1. Bulk /calendar/earnings for the last 5 trading days.
//   2. Filter to universe IN ∩ real_conid resolved.
//   3. Enqueue 'eval_post_earnings_drift' per (real_conid, report_date).
//   4. Drain done — worker returned {report_day_pop_pct, days_since,
//      today_close}; run scorePostEarningsDrift; write trait_scores +
//      notifyTraitFirstFire on first fire.
//
// Cadence: 24h, 11-min boot delay (after catalystReversalProducer).

import { notifyError, notifyTraitFirstFire } from '../services/notify.js';
import { traitScoresTableModule } from '../adapters/supabase/traitScoresTableModule.js';
import { universeTableModule } from '../adapters/supabase/universeTableModule.js';
import { getEarningsWindow } from '../services/earningsCalendar.js';
import {
  enqueue,
  drainDone,
  drainFailed,
  deleteJob,
  markRetry,
  finalizeFailure,
  type JobRow,
} from '../services/jobs/queue.js';
import { makeKey } from '../services/jobs/keys.js';
import { ibRegistry } from '../services/jobs/actions.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import {
  scorePostEarningsDrift,
  findReportDayPop,
} from '../services/screener/traits/postEarningsDrift.js';
import type { RawIbHistory } from '../types/index.js';
import { defineCron } from '../kernel/scheduler.js';
import { freshnessGate } from './gates.js';
import { onIbReconnect } from './ibReconnect.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 11 * 60_000;
const MAX_RETRY_ATTEMPTS = 2;
const LOOKBACK_TRADING_DAYS = 5;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

interface ReporterTarget {
  real_conid: number;
  symbol: string;
  report_date: string;
}

async function loadReporters(): Promise<ReporterTarget[]> {
  const from = daysAgoIsoDate(LOOKBACK_TRADING_DAYS);
  let earnings;
  try {
    // Shared once-per-day calendar pull (Batch X6); filter to this lookback.
    earnings = (await getEarningsWindow()).filter((r) => r.date != null && r.date >= from);
  } catch (e) {
    void notifyError('postEarningsDriftProducer.earningsCal', (e as Error).message, e);
    return [];
  }
  if (earnings.length === 0) return [];

  // Most-recent report-date per symbol (Finnhub may list multiple rows for
  // the same ticker in the window — rare but possible for revisions).
  const latestBySymbol = new Map<string, string>();
  for (const r of earnings) {
    if (!r.symbol || !r.date) continue;
    const cur = latestBySymbol.get(r.symbol);
    if (cur == null || r.date > cur) latestBySymbol.set(r.symbol, r.date);
  }
  const symbols = Array.from(latestBySymbol.keys());

  let rows;
  try {
    rows = await universeTableModule.getResolvedInRowsBySymbols(symbols);
  } catch (e) {
    void notifyError('postEarningsDriftProducer.loadReporters', (e as Error).message);
    return [];
  }
  const out: ReporterTarget[] = [];
  for (const row of rows) {
    if (row.realConid == null) continue;
    const rd = latestBySymbol.get(row.symbol);
    if (!rd) continue;
    out.push({ real_conid: row.realConid, symbol: row.symbol, report_date: rd });
  }
  return out;
}

async function enqueueJobs(targets: ReporterTarget[]): Promise<{ enqueued: number; deduped: number }> {
  const asof = todayIsoDate();
  let enqueued = 0, deduped = 0;
  for (const t of targets) {
    const jobKey = makeKey('eval_post_earnings_drift', t.real_conid, asof);
    try {
      const r = await enqueue(jobKey, 'eval_post_earnings_drift', 'ib', {
        real_conid: t.real_conid,
        symbol: t.symbol,
        report_date: t.report_date,
        asof_date: asof,
      });
      if (r === 'created') enqueued++; else deduped++;
    } catch (e) {
      void notifyError(`postEarningsDriftProducer.enqueue.${t.symbol}`, (e as Error).message);
    }
  }
  return { enqueued, deduped };
}

interface PedJobResult {
  report_day_pop_pct: number;
  days_since_earnings: number;
  today_close: number;
}

async function drainResults(): Promise<{ scored: number; dropped: number; retried: number; gave_up: number }> {
  const done = await drainDone('eval_post_earnings_drift').catch((e: Error) => {
    void notifyError('postEarningsDriftProducer.drainDone', e.message);
    return [] as JobRow[];
  });
  let scored = 0, dropped = 0;
  for (const j of done) {
    const payload = j.payload as { real_conid?: number; symbol?: string; asof_date?: string };
    const r = j.result as unknown as PedJobResult | undefined;
    if (!r || payload.real_conid == null || !payload.symbol || !payload.asof_date) {
      await deleteJob(j.id).catch(() => undefined);
      dropped++;
      continue;
    }
    const result = scorePostEarningsDrift({
      report_day_pop_pct: r.report_day_pop_pct,
      days_since_earnings: r.days_since_earnings,
      today_price: r.today_close,
    });
    if (!result) {
      dropped++;
      await deleteJob(j.id).catch(() => undefined);
      continue;
    }
    try {
      await traitScoresTableModule.upsertScores([
        {
          conid: payload.real_conid,
          trait: 'post_earnings_drift',
          asofDate: payload.asof_date,
          score: result.score,
          payload: result.payload,
        },
      ]);
    } catch (e) {
      void notifyError(`postEarningsDriftProducer.upsert.${payload.symbol}`, (e as Error).message);
      continue;
    }
    const firstFire = await traitScoresTableModule
      .stampFirstFire(payload.real_conid, 'post_earnings_drift', payload.asof_date)
      .catch(() => false);
    if (firstFire) {
      void notifyTraitFirstFire({
        trait: 'post_earnings_drift',
        symbol: payload.symbol,
        score: result.score,
        payload: result.payload,
      });
    }
    scored++;
    await deleteJob(j.id).catch(() => undefined);
  }

  const failed = await drainFailed('eval_post_earnings_drift').catch((e: Error) => {
    void notifyError('postEarningsDriftProducer.drainFailed', e.message);
    return [] as JobRow[];
  });
  let retried = 0, gave_up = 0;
  for (const j of failed) {
    if (j.attempts < MAX_RETRY_ATTEMPTS) {
      await markRetry(j).catch(() => undefined);
      retried++;
    } else {
      await finalizeFailure(j).catch(() => undefined);
      gave_up++;
    }
  }
  return { scored, dropped, retried, gave_up };
}

async function tick(): Promise<void> {
  const t0 = Date.now();
  const reporters = await loadReporters();
  const enq = await enqueueJobs(reporters);
  const drain = await drainResults();
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[postEarningsDriftProducer] reporters=${reporters.length} ` +
      `enq[new=${enq.enqueued} dedup=${enq.deduped}] ` +
      `drain[score=${drain.scored} drop=${drain.dropped} retry=${drain.retried} give-up=${drain.gave_up}] ` +
      `elapsed=${elapsedSec}s`,
  );
}

// Batch ARCH-10: hand-rolled loop → defineCron. The freshness gate skips a tick
// once today's scores exist, so an IB-reconnect trigger is a no-op when fresh
// and a full produce+drain when stale (e.g. eval jobs that completed while IB
// was down but haven't been drained into trait_scores yet).
const cron = defineCron({
  name: 'postEarningsDriftProducer',
  intervalMs: CADENCE_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  gates: [
    freshnessGate(async () => (await traitScoresTableModule.latestAsof(['post_earnings_drift'])) === todayIsoDate()),
  ],
  run: tick,
});

export function startPostEarningsDriftProducer(): void {
  cron.start();
  onIbReconnect(cron); // catch up the swing-list feed the moment IB returns
  console.log('[postEarningsDriftProducer] starting, 24h cadence + IB-reconnect trigger');
}

// ---------------------------------------------------------------------------
// Worker handler — `ib` pool. Pulls ~30 days of daily bars, extracts the
// report-day pop via the pure helper, returns the values to the producer.
// ---------------------------------------------------------------------------

interface PedPayload {
  real_conid: number;
  symbol: string;
  report_date: string;
  asof_date: string;
}

ibRegistry['eval_post_earnings_drift'] = async (payloadIn) => {
  const payload = payloadIn as unknown as PedPayload;
  if (payload.real_conid == null) throw new Error('eval_post_earnings_drift: missing real_conid');
  const hist: RawIbHistory | null = await ibGateway.history(payload.real_conid, '1m', '1d');
  if (!hist?.data || hist.data.length < 2) {
    throw new Error(`eval_post_earnings_drift: insufficient bars for ${payload.symbol}`);
  }
  const bars = hist.data.map((b) => ({ t: b.t, c: b.c }));
  const found = findReportDayPop(bars, payload.report_date);
  if (!found) {
    throw new Error(`eval_post_earnings_drift: no report-day bar for ${payload.symbol} on ${payload.report_date}`);
  }
  return found as unknown as Record<string, unknown>;
};
