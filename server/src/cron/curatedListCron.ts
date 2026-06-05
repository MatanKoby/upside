// curatedListCron — Batch X1.
//
// Rebuilds the curated list (the dip-bounce alert pool + walking-band pool).
// Reads today's `intraday_range_trader` trait scores, joins `universe` for the
// volume gate + symbol, then — in score order — pulls daily bars (IB) to compute
// each candidate's daily ATR%, applies the gates via buildCuratedList, and
// upserts the `curated_list` rows for today.
//
// IB-gated (daily ATR needs daily bars). 12h cadence from boot + a boot kick
// (the codebase schedules crons by interval-from-boot, not wall-clock; the spec's
// 09:00 / 15:30 IDT cadence is approximated by "rebuild whenever IB is up, a
// couple times a day"). Bounded IB: only volume-passing candidates, top
// MAX_CANDIDATES by score, are probed. Retention drops rows older than 7 days.

import { ibHistory, ibStatus } from '../services/ibGateway.js';
import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { atr } from '../services/technicals.js';
import { buildCuratedList, type CuratedCandidate } from '../services/curatedList/buildCuratedList.js';
import { MIN_AVG_VOLUME, MIN_DAILY_ATR_PCT, TARGET_SIZE } from '../config/curatedList.js';

const CADENCE_MS = 12 * 3600 * 1000;
const FIRST_RUN_DELAY_MS = 90_000;
const MAX_CANDIDATES = TARGET_SIZE * 3; // cap IB probes (top-N by score that pass volume)
const CHUNK = 900;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Seed {
  conid: number;
  score: number;
  avgDailyVolume: number | null;
}

// trait_scores (intraday_range_trader, today) ⨝ universe (real_conid) for the
// volume gate. Returns score-desc, volume-passing seeds capped at MAX_CANDIDATES.
async function loadSeeds(asof: string): Promise<Seed[]> {
  const { data: ts, error } = await supabase()
    .from('trait_scores')
    .select('conid, score')
    .eq('trait', 'intraday_range_trader')
    .eq('asof_date', asof);
  if (error) {
    void notifyError('curatedListCron.loadTraits', error.message);
    return [];
  }
  const scoreByConid = new Map<number, number>();
  for (const r of ts ?? []) {
    const c = num((r as { conid: unknown }).conid);
    const sc = num((r as { score: unknown }).score);
    if (c != null && sc != null) scoreByConid.set(c, sc);
  }
  const conids = [...scoreByConid.keys()];
  if (conids.length === 0) return [];

  const volByConid = new Map<number, number | null>();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data: u } = await supabase()
      .from('universe')
      .select('real_conid, last_avg_volume')
      .in('real_conid', conids.slice(i, i + CHUNK));
    for (const row of u ?? []) {
      const c = num((row as { real_conid: unknown }).real_conid);
      if (c != null) volByConid.set(c, num((row as { last_avg_volume: unknown }).last_avg_volume));
    }
  }

  return conids
    .map((c) => ({ conid: c, score: scoreByConid.get(c)!, avgDailyVolume: volByConid.get(c) ?? null }))
    .filter((s) => s.avgDailyVolume != null && s.avgDailyVolume >= MIN_AVG_VOLUME)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

async function dailyAtrPct(conid: number): Promise<number | null> {
  const hist = await ibHistory(conid, '3m', '1d');
  const bars = hist?.data ?? [];
  if (bars.length < 15) return null;
  const a = atr({ o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v) });
  const lastClose = bars[bars.length - 1]?.c ?? null;
  if (a == null || lastClose == null || lastClose <= 0) return null;
  return (a / lastClose) * 100;
}

async function persist(asof: string, rows: ReturnType<typeof buildCuratedList>): Promise<void> {
  const db = supabase();
  if (rows.length > 0) {
    const payload = rows.map((r) => ({
      conid: r.conid,
      asof_date: asof,
      rank: r.rank,
      intraday_range_trader_score: r.intradayRangeTraderScore,
      avg_daily_volume: r.avgDailyVolume,
      daily_atr_pct: r.dailyAtrPct,
      computed_at: new Date().toISOString(),
    }));
    const { error } = await db.from('curated_list').upsert(payload, { onConflict: 'conid,asof_date' });
    if (error) { void notifyError('curatedListCron.persist', error.message); return; }
  }
  // Drop today's rows that fell out of the new set.
  const keep = new Set(rows.map((r) => r.conid));
  const { data: existing } = await db.from('curated_list').select('conid').eq('asof_date', asof);
  const stale = (existing ?? []).map((r) => num((r as { conid: unknown }).conid)).filter((c): c is number => c != null && !keep.has(c));
  for (let i = 0; i < stale.length; i += CHUNK) {
    await db.from('curated_list').delete().eq('asof_date', asof).in('conid', stale.slice(i, i + CHUNK));
  }
}

async function retention(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await supabase().from('curated_list').delete().lt('asof_date', cutoff);
}

async function tick(): Promise<void> {
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) return; // daily ATR needs IB

  const asof = utcDate();
  const seeds = await loadSeeds(asof);
  if (seeds.length === 0) {
    console.log('[curatedListCron] no intraday_range_trader seeds for today');
    return;
  }

  // Probe in score order; stop once we have TARGET_SIZE that pass the ATR gate.
  const candidates: CuratedCandidate[] = [];
  let passing = 0;
  for (const s of seeds) {
    if (passing >= TARGET_SIZE) break;
    let atrPct: number | null = null;
    try {
      atrPct = await dailyAtrPct(s.conid);
    } catch (e) {
      void notifyError(`curatedListCron.atr.${s.conid}`, (e as Error).message, e);
    }
    candidates.push({
      conid: s.conid,
      intradayRangeTraderScore: s.score,
      avgDailyVolume: s.avgDailyVolume,
      dailyAtrPct: atrPct,
    });
    if (atrPct != null && atrPct >= MIN_DAILY_ATR_PCT && s.avgDailyVolume != null) passing++;
  }

  const rows = buildCuratedList(candidates);
  await persist(asof, rows);
  await retention();
  console.log(`[curatedListCron] asof=${asof} seeds=${seeds.length} probed=${candidates.length} curated=${rows.length}`);
}

export function startCuratedListCron(): void {
  console.log('[curatedListCron] starting, 12h cadence (IB-gated)');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('curatedListCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
