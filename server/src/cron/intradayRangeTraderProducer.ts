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

import { universeTableModule } from '../adapters/supabase/universeTableModule.js';
import { quotesTableModule } from '../adapters/supabase/quotesTableModule.js';
import { intradayStatsTableModule } from '../adapters/supabase/intradayStatsTableModule.js';
import { notifyError } from '../services/notify.js';
import { traitScoresTableModule, type TraitScore } from '../adapters/supabase/traitScoresTableModule.js';
import {
  scoreIntradayRangeTrader,
  type IntradayStatsRow,
} from '../services/screener/traits/intradayRangeTrader.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 6 * 60_000;

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
  let universe;
  try {
    universe = await universeTableModule.getResolvedInRows();
  } catch (e) {
    void notifyError('intradayRangeTraderProducer.loadUniverse', (e as Error).message);
    return [];
  }
  if (universe.length === 0) return [];

  const conids = universe.map((r) => r.realConid).filter((c): c is number => c != null);
  const statsByConid = new Map<number, IntradayStatsRow>();
  try {
    for (const s of await intradayStatsTableModule.getByConids(conids)) {
      statsByConid.set(s.conid, {
        intraday_low_pct_p50: s.p50,
        intraday_low_pct_p75: s.p75,
        sample_size: s.sampleSize,
      });
    }
  } catch (e) {
    void notifyError('intradayRangeTraderProducer.loadStats', (e as Error).message);
  }

  // today_open for the band-low projection lives on quotes (the watchlist
  // tracking surface). Universe-only tickers have no quote row; today_open
  // is null for them and the band_low payload field comes back null too —
  // the FE renders an em-dash there.
  const openByConid = new Map<number, number | null>();
  try {
    for (const r of await quotesTableModule.getTodayOpens(conids.slice(0, 900))) {
      openByConid.set(r.conid, r.todayOpen);
    }
  } catch (e) {
    void notifyError('intradayRangeTraderProducer.loadOpens', (e as Error).message);
  }

  const joined: UniverseStatsJoin[] = [];
  for (const row of universe) {
    if (row.realConid == null) continue;
    const stats = statsByConid.get(row.realConid);
    if (!stats) continue;
    joined.push({
      real_conid: row.realConid,
      symbol: row.symbol,
      last_price: row.lastPrice,
      stats,
      today_open: openByConid.get(row.realConid) ?? null,
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
