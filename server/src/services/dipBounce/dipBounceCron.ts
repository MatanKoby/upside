// dipBounceCron — Batch X1.
//
// Runs both dip-bounce scorers over the compute set (curated ∪ active-watchlist
// ∪ held) on a 60s cadence during regular + after-hours. The intraday scorer is
// pure table composition (quotes / intraday_stats / band_state / entry_zones) —
// it keeps firing on Finnhub-updated quotes even when IB is off. The swing
// scorer additionally needs daily indicators (RSI / ATR / trend), which come
// from the feature pack (technicals.ts) computed once per session per conid from
// an IB daily-bar pull and cached in memory — so swing only scores names whose
// pack is cached (IB was up at least once this session). Fires write a
// `signal_fires` row + a Discord ping with a per-(conid, kind) cooldown read
// off the latest fire. Spec: spec/signals/dip-bounce-scorer.md.

import { ibHistory, ibStatus } from '../ibGateway.js';
import { supabase } from '../supabase.js';
import { notifyError, notifyIntradayDipBounce, notifySwingDipBounce } from '../notify.js';
import { marketPeriodAt, etDateString } from '../../utils/marketHours.js';
import { buildFeaturePack, type FeaturePack } from '../technicals.js';
import { loadComputeSet, type ComputeMember } from './computeSet.js';
import { computeIntradayDipBounceScore } from './intradayScorer.js';
import { computeSwingDipBounceScore } from './swingScorer.js';
import {
  INTRADAY_COOLDOWN_HOURS,
  SWING_COOLDOWN_HOURS,
} from '../../config/dipBounceScorer.js';

const CADENCE_MS = 60_000;
const FIRST_RUN_DELAY_MS = 90_000;
const CHUNK = 900;

type Kind = 'intraday_dip_bounce' | 'swing_dip_bounce';

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasConfluence(reasoning: string | null | undefined): boolean {
  return reasoning != null && /confluence/i.test(reasoning);
}

interface QuoteInput { price: number | null; todayOpen: number | null }
interface StatsInput { p50: number | null; p75: number | null }
interface BandInput { sessionRegime: string | null; volRegimeShift: boolean | null }
interface ZoneInput { price: number; trendRegime: string | null; hasConfluence: boolean }

// ── Per-session daily-pack cache (RSI / ATR / trend for the swing scorer) ─────
let packCache = new Map<number, FeaturePack>();
let packCacheDate = '';

function resetCacheIfNewSession(sessionDate: string): void {
  if (packCacheDate !== sessionDate) {
    packCache = new Map();
    packCacheDate = sessionDate;
  }
}

async function refreshPacks(members: ComputeMember[], quotes: Map<number, QuoteInput>): Promise<void> {
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) return; // IB off → leave cache as-is
  for (const m of members) {
    if (packCache.has(m.conid)) continue;
    try {
      const hist = await ibHistory(m.conid, '3m', '1d');
      const bars = hist?.data ?? [];
      if (bars.length === 0) continue;
      const daily = {
        o: bars.map((b) => b.o),
        h: bars.map((b) => b.h),
        l: bars.map((b) => b.l),
        c: bars.map((b) => b.c),
        v: bars.map((b) => b.v),
      };
      const pack = buildFeaturePack({
        daily,
        intraday: null,
        currentPrice: quotes.get(m.conid)?.price ?? null,
        avgCost: null,
      });
      packCache.set(m.conid, pack);
    } catch (e) {
      void notifyError(`dipBounceCron.pack.${m.symbol}`, (e as Error).message, e);
    }
  }
}

// ── Batch table loads ────────────────────────────────────────────────────────
async function loadQuotes(conids: number[]): Promise<Map<number, QuoteInput>> {
  const out = new Map<number, QuoteInput>();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data } = await supabase()
      .from('quotes')
      .select('conid, canonical_price, today_open')
      .in('conid', conids.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      if (c != null) out.set(c, { price: num((r as { canonical_price: unknown }).canonical_price), todayOpen: num((r as { today_open: unknown }).today_open) });
    }
  }
  return out;
}

async function loadStats(conids: number[]): Promise<Map<number, StatsInput>> {
  const out = new Map<number, StatsInput>();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data } = await supabase()
      .from('intraday_stats')
      .select('conid, intraday_low_pct_p50, intraday_low_pct_p75')
      .in('conid', conids.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      if (c != null) out.set(c, { p50: num((r as { intraday_low_pct_p50: unknown }).intraday_low_pct_p50), p75: num((r as { intraday_low_pct_p75: unknown }).intraday_low_pct_p75) });
    }
  }
  return out;
}

async function loadBands(conids: number[], sessionDate: string): Promise<Map<number, BandInput>> {
  const out = new Map<number, BandInput>();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data } = await supabase()
      .from('band_state')
      .select('conid, session_regime, vol_regime_shift')
      .eq('session_date', sessionDate)
      .in('conid', conids.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      if (c != null) out.set(c, { sessionRegime: ((r as { session_regime: string | null }).session_regime) ?? null, volRegimeShift: (r as { vol_regime_shift: boolean | null }).vol_regime_shift ?? null });
    }
  }
  return out;
}

async function loadZones(conids: number[]): Promise<Map<number, Partial<Record<'intraday' | 'overnight' | 'multiday', ZoneInput>>>> {
  const out = new Map<number, Partial<Record<'intraday' | 'overnight' | 'multiday', ZoneInput>>>();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data } = await supabase()
      .from('entry_zones')
      .select('conid, horizon, price, reasoning, trend_regime')
      .in('conid', conids.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      const horizon = (r as { horizon: string }).horizon as 'intraday' | 'overnight' | 'multiday';
      const price = num((r as { price: unknown }).price);
      if (c == null || price == null) continue;
      const entry = out.get(c) ?? {};
      entry[horizon] = {
        price,
        trendRegime: (r as { trend_regime: string | null }).trend_regime ?? null,
        hasConfluence: hasConfluence((r as { reasoning: string | null }).reasoning),
      };
      out.set(c, entry);
    }
  }
  return out;
}

/** Latest fire ts (ms) per `${conid}:${kind}` within the last 24h. */
async function loadLastFires(conids: number[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (let i = 0; i < conids.length; i += CHUNK) {
    const { data } = await supabase()
      .from('signal_fires')
      .select('conid, signal_kind, fire_ts')
      .in('conid', conids.slice(i, i + CHUNK))
      .in('signal_kind', ['intraday_dip_bounce', 'swing_dip_bounce'])
      .gte('fire_ts', since)
      .order('fire_ts', { ascending: false });
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      const kind = (r as { signal_kind: string }).signal_kind;
      const ts = new Date((r as { fire_ts: string }).fire_ts).getTime();
      if (c == null || !Number.isFinite(ts)) continue;
      const key = `${c}:${kind}`;
      if (!out.has(key)) out.set(key, ts); // first = newest (ordered desc)
    }
  }
  return out;
}

function cooldownPassed(lastMs: number | undefined, hours: number): boolean {
  if (lastMs == null) return true;
  return Date.now() - lastMs >= hours * 3600 * 1000;
}

async function recordFire(args: {
  conid: number;
  kind: Kind;
  score: number;
  components: Record<string, number>;
  horizon: 'intraday' | 'swing';
  price: number | null;
}): Promise<void> {
  const { error } = await supabase().from('signal_fires').insert({
    conid: args.conid,
    signal_kind: args.kind,
    score: args.score,
    components: args.components,
    horizon: args.horizon,
    price_at_fire: args.price,
  });
  if (error) void notifyError(`dipBounceCron.recordFire.${args.conid}`, error.message);
}

function structureToTrend(s: FeaturePack['trend']['structure']): string | null {
  if (s === 'higher-highs') return 'up';
  if (s === 'lower-lows') return 'down';
  if (s === 'mixed') return 'mixed';
  return null;
}

async function tick(): Promise<void> {
  const period = marketPeriodAt();
  if (period !== 'regular' && period !== 'after-hours') return;

  const sessionDate = etDateString(); // band_state key
  const curatedAsof = new Date().toISOString().slice(0, 10); // curated_list / trait_scores key
  resetCacheIfNewSession(sessionDate);

  const members = await loadComputeSet(curatedAsof);
  if (members.length === 0) return;
  const conids = members.map((m) => m.conid);

  const [quotes, stats, bands, zones, lastFires] = await Promise.all([
    loadQuotes(conids),
    loadStats(conids),
    loadBands(conids, sessionDate),
    loadZones(conids),
    loadLastFires(conids),
  ]);

  await refreshPacks(members, quotes);

  let intradayFires = 0;
  let swingFires = 0;
  for (const m of members) {
    const q = quotes.get(m.conid) ?? { price: null, todayOpen: null };
    const s = stats.get(m.conid) ?? { p50: null, p75: null };
    const b = bands.get(m.conid) ?? { sessionRegime: null, volRegimeShift: null };
    const z = zones.get(m.conid) ?? {};

    // Intraday scorer (table-only).
    const intraday = computeIntradayDipBounceScore({
      todayOpen: q.todayOpen,
      currentPrice: q.price,
      intradayLowPctP50: s.p50,
      intradayLowPctP75: s.p75,
      sessionRegime: b.sessionRegime,
      volRegimeShift: b.volRegimeShift,
      intradayZone: z.intraday ? { trendRegime: z.intraday.trendRegime, hasConfluence: z.intraday.hasConfluence } : null,
    });
    if (intraday.fired && cooldownPassed(lastFires.get(`${m.conid}:intraday_dip_bounce`), INTRADAY_COOLDOWN_HOURS)) {
      await recordFire({ conid: m.conid, kind: 'intraday_dip_bounce', score: intraday.score, components: intraday.components, horizon: 'intraday', price: q.price });
      await notifyIntradayDipBounce({
        symbol: m.symbol,
        score: intraday.score,
        currentPrice: q.price,
        dropPct: intraday.dropPct,
        sessionRegime: b.sessionRegime,
        entryZonePrice: z.intraday?.price ?? null,
        hasConfluence: z.intraday?.hasConfluence ?? false,
      }).catch((e) => void notifyError(`dipBounceCron.notifyIntraday.${m.symbol}`, (e as Error).message, e));
      intradayFires++;
    }

    // Swing scorer (needs the cached daily pack).
    const pack = packCache.get(m.conid);
    if (pack) {
      const swing = computeSwingDipBounceScore({
        trendStructure: pack.trend.structure,
        rsi14: pack.momentum.rsi14,
        atrDaily: pack.volatility.atr14,
        currentPrice: q.price,
        sessionRegime: b.sessionRegime,
        volRegimeShift: b.volRegimeShift,
        overnightZone: z.overnight ? { price: z.overnight.price, hasConfluence: z.overnight.hasConfluence } : null,
        multidayZone: z.multiday ? { price: z.multiday.price, hasConfluence: z.multiday.hasConfluence } : null,
      });
      if (swing.fired && cooldownPassed(lastFires.get(`${m.conid}:swing_dip_bounce`), SWING_COOLDOWN_HOURS)) {
        await recordFire({ conid: m.conid, kind: 'swing_dip_bounce', score: swing.score, components: swing.components, horizon: 'swing', price: q.price });
        await notifySwingDipBounce({
          symbol: m.symbol,
          score: swing.score,
          currentPrice: q.price,
          trend: structureToTrend(pack.trend.structure),
          rsi14: pack.momentum.rsi14,
          overnightZonePrice: z.overnight?.price ?? null,
          multidayZonePrice: z.multiday?.price ?? null,
        }).catch((e) => void notifyError(`dipBounceCron.notifySwing.${m.symbol}`, (e as Error).message, e));
        swingFires++;
      }
    }
  }

  if (intradayFires > 0 || swingFires > 0) {
    console.log(`[dipBounceCron] members=${members.length} intradayFires=${intradayFires} swingFires=${swingFires}`);
  }
}

export function startDipBounceCron(): void {
  console.log('[dipBounceCron] starting, 60s cadence during regular + after-hours');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('dipBounceCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
