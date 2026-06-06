// curatedListCron — Batch X1.
//
// Rebuilds the curated list (the dip-bounce alert pool + walking-band pool).
// Reads today's `intraday_range_trader` trait scores, then — in score order —
// reads each candidate's daily bars from the `daily_bars` SSOT (Polygon-primary,
// Batch X4) to compute BOTH the daily ATR% and the 30d median average daily
// volume (ADV) from the same bars, applies the gates via buildCuratedList, and
// upserts the `curated_list` rows for today.
//
// The volume gate reads bar-derived median ADV, not `universe.last_avg_volume`
// (see spec/signals/curated-list.md → Volume source; Batch X3).
//
// No longer IB-gated (Batch X4): daily bars come from daily_bars, which Polygon
// keeps fresh on weekends/off-hours, so the list rebuilds when IB history is
// down. 12h cadence from boot + a boot kick (the codebase schedules crons by
// interval-from-boot; the spec's 09:00 / 15:30 IDT cadence is approximated by
// "rebuild a couple times a day"). Bounded: the top MAX_CANDIDATES seeds by
// trait score are probed. Retention drops rows older than 7 days.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { atr } from '../services/technicals.js';
import { loadDailyBars } from '../services/dailyBars.js';
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

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Seed {
  conid: number;
  score: number;
}

// trait_scores (intraday_range_trader, today) → seeds, score-desc, capped at
// MAX_CANDIDATES. No volume pre-filter here: ADV is computed per candidate from
// the same daily bars as ATR (see dailyMetrics), so the volume gate lives in
// buildCuratedList alongside the ATR gate.
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
  const seeds: Seed[] = [];
  for (const r of ts ?? []) {
    const c = num((r as { conid: unknown }).conid);
    const sc = num((r as { score: unknown }).score);
    if (c != null && sc != null) seeds.push({ conid: c, score: sc });
  }
  seeds.sort((a, b) => b.score - a.score);
  return seeds.slice(0, MAX_CANDIDATES);
}

// One daily_bars read → both the daily ATR% and the 30d median ADV. Returns
// nulls (which fail the gates in buildCuratedList) when bars are missing/short.
async function dailyMetrics(conid: number): Promise<{ atrPct: number | null; medAdv: number | null }> {
  const bars = await loadDailyBars(conid, 90);
  if (bars.length < 15) return { atrPct: null, medAdv: null };
  const a = atr({ o: bars.map((b) => b.o), h: bars.map((b) => b.h), l: bars.map((b) => b.l), c: bars.map((b) => b.c), v: bars.map((b) => b.v) });
  const lastClose = bars[bars.length - 1]?.c ?? null;
  const atrPct = a != null && lastClose != null && lastClose > 0 ? (a / lastClose) * 100 : null;
  // 30d median daily volume from the same bars — median, not mean, so a single
  // news-day spike can't sneak an illiquid name past the volume gate.
  const vols = bars
    .slice(-30)
    .map((b) => b.v)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const medAdv = vols.length > 0 ? median(vols) : null;
  return { atrPct, medAdv };
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
  const asof = utcDate();
  const seeds = await loadSeeds(asof);
  if (seeds.length === 0) {
    console.log('[curatedListCron] no intraday_range_trader seeds for today');
    return;
  }

  // Probe in score order; stop once we have TARGET_SIZE that pass both gates.
  const candidates: CuratedCandidate[] = [];
  let passing = 0;
  for (const s of seeds) {
    if (passing >= TARGET_SIZE) break;
    let atrPct: number | null = null;
    let medAdv: number | null = null;
    try {
      ({ atrPct, medAdv } = await dailyMetrics(s.conid));
    } catch (e) {
      void notifyError(`curatedListCron.probe.${s.conid}`, (e as Error).message, e);
    }
    candidates.push({
      conid: s.conid,
      intradayRangeTraderScore: s.score,
      avgDailyVolume: medAdv,
      dailyAtrPct: atrPct,
    });
    if (atrPct != null && atrPct >= MIN_DAILY_ATR_PCT && medAdv != null && medAdv >= MIN_AVG_VOLUME) passing++;
  }

  const rows = buildCuratedList(candidates);
  await persist(asof, rows);
  await retention();
  console.log(`[curatedListCron] asof=${asof} seeds=${seeds.length} probed=${candidates.length} curated=${rows.length}`);
}

export function startCuratedListCron(): void {
  console.log('[curatedListCron] starting, 12h cadence (daily_bars-backed)');
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
