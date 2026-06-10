// intradayRangeTraderProducer — Batch S2.
//
// Daily inline cron. Joins universe (filter_result='in' AND real_conid IS
// NOT NULL) to intraday_stats by real_conid, runs the pure trait scorer,
// and upserts a trait_scores row per qualifying ticker for today's
// asof_date. No upstream API calls — pure DB compute, so no job-queue
// indirection needed. Re-running same-day is idempotent (overwrite).
//
// Silent trait per spec/signals/screener-universe.md → Discord ping policy
// (the baseline-of-the-screener; pinging every match would be noise; band-
// touch alerts under band-engine.md carry the actionable events here).
//
// Cadence: 24h, runs 6 min after boot so it lands after intradayStatsCron's
// first tick has had a chance to populate fresh data on day-of-cron-deploy.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { traitScoresTableModule, type TraitScore } from '../db/traitScoresTableModule.js';
import {
  scoreIntradayRangeTrader,
  type IntradayStatsRow,
} from '../services/screener/traits/intradayRangeTrader.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 6 * 60_000;
const BATCH_LIMIT = 5000;

interface UniverseStatsJoin {
  real_conid: number;
  symbol: string;
  last_price: number | null;
  stats: IntradayStatsRow;
  today_open: number | null;
}

function todayIsoDate(): string {
  // YYYY-MM-DD in UTC. trait_scores.asof_date is just a calendar slot for
  // shelf-life arithmetic; matching the universe pipeline's UTC date keeps
  // the day boundaries consistent across crons.
  return new Date().toISOString().slice(0, 10);
}

async function loadJoined(): Promise<UniverseStatsJoin[]> {
  // Two-query join (PostgREST doesn't trivially traverse non-FK relations).
  // 1. Universe IN rows with real_conid.
  // 2. intraday_stats by those conids.
  // Sample-sized at single-user scale (~3,000 IN rows).
  const u = await supabase()
    .from('universe')
    .select('real_conid, symbol, last_price')
    .eq('filter_result', 'in')
    .not('real_conid', 'is', null)
    .limit(BATCH_LIMIT);
  if (u.error) {
    void notifyError('intradayRangeTraderProducer.loadUniverse', u.error.message);
    return [];
  }
  const universe = (u.data ?? []) as Array<{ real_conid: number; symbol: string; last_price: number | null }>;
  if (universe.length === 0) return [];

  const conids = universe.map((r) => r.real_conid);
  // Supabase 'in' filter caps at ~1000 values; chunk if needed.
  const statsRows: Array<{ conid: number; intraday_low_pct_p50: number | null; intraday_low_pct_p75: number | null; sample_size: number }> = [];
  for (let i = 0; i < conids.length; i += 900) {
    const chunk = conids.slice(i, i + 900);
    const { data, error } = await supabase()
      .from('intraday_stats')
      .select('conid, intraday_low_pct_p50, intraday_low_pct_p75, sample_size')
      .in('conid', chunk);
    if (error) {
      void notifyError('intradayRangeTraderProducer.loadStats', error.message);
      continue;
    }
    statsRows.push(...(data ?? []));
  }
  const statsByConid = new Map(statsRows.map((s) => [s.conid, s]));

  // today_open for the band-low projection lives on quotes (the watchlist
  // tracking surface). Universe-only tickers have no quote row; today_open
  // is null for them and the band_low payload field comes back null too —
  // the FE renders an em-dash there.
  const { data: quotes } = await supabase()
    .from('quotes')
    .select('conid, today_open')
    .in('conid', conids.slice(0, 900));
  const openByConid = new Map<number, number | null>(
    (quotes ?? []).map((q: { conid: number; today_open: number | null }) => [q.conid, q.today_open]),
  );

  const joined: UniverseStatsJoin[] = [];
  for (const row of universe) {
    const stats = statsByConid.get(row.real_conid);
    if (!stats) continue;
    joined.push({
      real_conid: row.real_conid,
      symbol: row.symbol,
      last_price: row.last_price,
      stats,
      today_open: openByConid.get(row.real_conid) ?? null,
    });
  }
  return joined;
}

async function tick(): Promise<void> {
  const t0 = Date.now();
  const asof = todayIsoDate();
  const joined = await loadJoined();
  if (joined.length === 0) {
    console.log('[intradayRangeTraderProducer] no joined rows; nothing to score');
    return;
  }

  let qualified = 0;
  const rows: TraitScore[] = [];
  for (const j of joined) {
    const r = scoreIntradayRangeTrader(j.stats, j.today_open, j.last_price);
    if (!r) continue;
    qualified++;
    rows.push({
      conid: j.real_conid,
      trait: 'intraday_range_trader',
      asofDate: asof,
      score: r.score,
      payload: r.payload,
    });
  }

  // Sole writer of the intraday_range_trader trait — chunked batch upsert
  // behind the module (PostgREST UPSERT on the composite PK).
  try {
    await traitScoresTableModule.upsertScores(rows);
  } catch (e) {
    void notifyError('intradayRangeTraderProducer.upsert', (e as Error).message);
  }

  console.log(
    `[intradayRangeTraderProducer] joined=${joined.length} qualified=${qualified} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

export function startIntradayRangeTraderProducer(): void {
  console.log('[intradayRangeTraderProducer] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('intradayRangeTraderProducer.loop', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
