// useVirtualList(kind) — the data behind the Intraday / Swing virtual lists
// (Batch X2). Pure FE consumer of X1's outputs; no schema/engine touch.
//
// Both lists draw from the same union — curated_list (the `dip` character pool)
// ∪ the event-trait names (catalyst_reversal → both lists, post_earnings_drift
// → swing) — and differ only by their composite-rank lens (config/virtualList).
// Each is a living top-N leaderboard: low-relevance names sink below the cut.
//
// Data sources (all FE-readable; `universe` is NOT granted to authenticated, so
// event membership comes from trait_scores and symbols come from quotes):
//   curated_list   — `dip` membership + intraday_range_trader_score (today, UTC)
//   trait_scores   — catalyst / post-earnings membership + score (today, UTC)
//   quotes         — conid → symbol + price + change + sparkline
//   band_state     — walking-band chip (latest session_date per conid)
//   signal_fires   — ⚡ just-fired marker + the rolling-30d hit-rate numerator
//   signal_outcomes— the rolling-30d hit-rate (per-conid, recomputed client-side
//                    because signal_hit_rate_30d aggregates per-kind)

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import {
  type VirtualKind,
  type ReasonChip,
  VIRTUAL_LIST_TOP_N,
  INTRADAY_WEIGHTS,
  SWING_WEIGHTS,
  FIRE_LIVE_WINDOW_HOURS,
  HIT_RATE_WINDOW_DAYS,
  HIT_RATE_DEF,
  NEWS_RANK_SCALE,
} from '../config/virtualList';

export interface VirtualBand {
  sessionRegime: string | null;
  volScalar: number | null;
  lowBand: number | null;
  highBand: number | null;
}

export type NewsLabel = 'bullish' | 'neutral' | 'bearish';
export interface VirtualNews {
  label: NewsLabel;
  score: number; // ∈ ~[-1,+1]
  headline: string | null;
}

export interface VirtualRow {
  conid: number;
  symbol: string;
  companyName: string | null;
  price: number | null;
  source: 'ib' | 'finnhub' | 'daily' | null;
  todayChangePct: number | null;
  todayOpen: number | null;
  sparklineCloses: number[] | null;
  reasons: ReasonChip[];
  justFired: boolean; // a live fire of THIS list's kind (within cooldown)
  band: VirtualBand | null;
  hitRate: { pct: number; sample: number } | null; // null = no graded fires in 30d
  news: VirtualNews | null; // today's news sentiment (Batch X7), null = no news
  score: number; // composite rank value (descending)
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// Days past which the latest pool is treated as stale (covers a weekend).
const STALENESS_CAP_DAYS = 4;

function isStaleDate(asof: string): boolean {
  const ageDays = (Date.now() - Date.parse(`${asof}T00:00:00Z`)) / 86_400_000;
  return ageDays > STALENESS_CAP_DAYS;
}

// The pipeline is daily-grain and may lag today (build race, weekends,
// pre-market). Render the LATEST available pool, not strictly today (Batch X9);
// the UI badges its age. See spec/signals/curated-list.md → Population & freshness.
//
// The two membership sources advance on DIFFERENT schedules — `curated_list`
// rebuilds on a 12h cron while the event traits refresh at each boot — so each
// must resolve its OWN latest date. Coupling them to a single global max blanks
// the (curated-only) intraday list whenever trait_scores is a day ahead. The
// trait date is scoped to the EVENT traits only; `intraday_range_trader` is the
// curated seed (not a list member) and would otherwise drag the date forward.
const EVENT_TRAITS = ['catalyst_reversal', 'post_earnings_drift'] as const;

async function latestPoolDates(): Promise<{ curated: string | null; trait: string | null }> {
  const [cur, trait] = await Promise.all([
    supabase.from('curated_list').select('asof_date').order('asof_date', { ascending: false }).limit(1),
    supabase
      .from('trait_scores')
      .select('asof_date')
      .in('trait', EVENT_TRAITS as unknown as string[])
      .order('asof_date', { ascending: false })
      .limit(1),
  ]);
  return {
    curated: (cur.data?.[0] as { asof_date?: string } | undefined)?.asof_date ?? null,
    trait: (trait.data?.[0] as { asof_date?: string } | undefined)?.asof_date ?? null,
  };
}

const FIRE_KIND: Record<VirtualKind, keyof typeof FIRE_LIVE_WINDOW_HOURS> = {
  intraday: 'intraday_dip_bounce',
  swing: 'swing_dip_bounce',
};

interface Acc {
  reasons: Set<ReasonChip>;
  character: number; // intraday_range_trader score
  catalyst: number; // catalyst_reversal trait score
  postEarnings: number; // post_earnings_drift trait score
  lowBand: number | null; // for marker prefill
}

export function useVirtualList(kind: VirtualKind): { rows: VirtualRow[]; loading: boolean; asof: string | null; stale: boolean } {
  const [rows, setRows] = useState<VirtualRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [asof, setAsof] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      // Each membership source resolves its OWN latest date (they advance on
      // different schedules). The badge reflects the newest pool actually shown.
      const dates = await latestPoolDates();
      const curatedAsof = dates.curated ?? utcToday();
      const traitAsof = dates.trait ?? utcToday();
      const asof =
        [dates.curated, dates.trait].filter((d): d is string => typeof d === 'string').sort().reverse()[0] ??
        utcToday();
      if (alive) {
        setAsof(asof);
        setStale(isStaleDate(asof));
      }
      const fireKind = FIRE_KIND[kind];
      const { offset, thresholdPct } = HIT_RATE_DEF[fireKind];
      const liveCutoff = Date.now() - FIRE_LIVE_WINDOW_HOURS[fireKind] * 3600_000;
      const hitRateCutoff = new Date(Date.now() - HIT_RATE_WINDOW_DAYS * 86_400_000).toISOString();

      // 1) union members — curated (dip) + event traits (catalyst / post-earnings).
      // Each queried at its own latest date (see latestPoolDates).
      const [curatedRes, traitRes] = await Promise.all([
        supabase
          .from('curated_list')
          .select('conid, intraday_range_trader_score')
          .eq('asof_date', curatedAsof),
        supabase
          .from('trait_scores')
          .select('conid, trait, score')
          .eq('asof_date', traitAsof)
          .in('trait', EVENT_TRAITS as unknown as string[]),
      ]);

      const acc = new Map<number, Acc>();
      const ensure = (c: number): Acc => {
        let a = acc.get(c);
        if (!a) {
          a = { reasons: new Set(), character: 0, catalyst: 0, postEarnings: 0, lowBand: null };
          acc.set(c, a);
        }
        return a;
      };
      for (const r of (curatedRes.data ?? []) as Array<{ conid: number | string; intraday_range_trader_score: number | string | null }>) {
        const c = Number(r.conid);
        const a = ensure(c);
        a.reasons.add('dip');
        a.character = num(r.intraday_range_trader_score) ?? 0;
      }
      for (const r of (traitRes.data ?? []) as Array<{ conid: number | string; trait: string; score: number | string | null }>) {
        const c = Number(r.conid);
        const a = ensure(c);
        const s = num(r.score) ?? 0;
        if (r.trait === 'catalyst_reversal') {
          a.reasons.add('catalyst');
          a.catalyst = s;
        } else if (r.trait === 'post_earnings_drift') {
          a.reasons.add('post-earnings');
          a.postEarnings = s;
        }
      }

      const conids = [...acc.keys()];
      if (conids.length === 0) {
        if (alive) {
          setRows([]);
          setLoading(false);
        }
        return;
      }

      // 2) quotes (symbol + price), band_state, recent fires + their outcomes, news
      const [quotesRes, bandRes, firesRes, newsRes] = await Promise.all([
        supabase
          .from('quotes')
          .select('conid, symbol, canonical_price, canonical_source, today_change_pct, today_open, sparkline_closes')
          .in('conid', conids),
        supabase
          .from('band_state')
          .select('conid, session_date, session_regime, vol_scalar, current_low_band, current_high_band')
          .in('conid', conids)
          .order('session_date', { ascending: false }),
        supabase
          .from('signal_fires')
          .select('id, conid, signal_kind, fire_ts')
          .eq('signal_kind', fireKind)
          .gte('fire_ts', hitRateCutoff)
          .in('conid', conids),
        supabase
          .from('news_sentiment')
          .select('conid, score, label, top_headline')
          .eq('asof_date', asof)
          .in('conid', conids),
      ]);

      // today's news sentiment per conid (Batch X7) → chip + rank nudge
      const newsByConid = new Map<number, VirtualNews>();
      for (const r of (newsRes.data ?? []) as Array<{ conid: number | string; score: number | string | null; label: NewsLabel; top_headline: string | null }>) {
        const score = num(r.score);
        if (score == null) continue;
        newsByConid.set(Number(r.conid), { label: r.label, score, headline: r.top_headline });
      }

      interface QRow {
        conid: number | string;
        symbol: string;
        canonical_price: number | string | null;
        canonical_source: 'ib' | 'finnhub' | 'daily' | null;
        today_change_pct: number | string | null;
        today_open: number | string | null;
        sparkline_closes: unknown;
      }
      const qByConid = new Map<number, QRow>();
      for (const r of (quotesRes.data ?? []) as QRow[]) qByConid.set(Number(r.conid), r);

      // latest band row per conid (already ordered session_date desc)
      const bandByConid = new Map<number, VirtualBand & { lowBand: number | null }>();
      for (const r of (bandRes.data ?? []) as Array<Record<string, unknown>>) {
        const c = Number(r.conid);
        if (bandByConid.has(c)) continue;
        bandByConid.set(c, {
          sessionRegime: (r.session_regime as string | null) ?? null,
          volScalar: num(r.vol_scalar),
          lowBand: num(r.current_low_band),
          highBand: num(r.current_high_band),
        });
      }

      // fires: split into "live" (⚡) and the 30d set graded for hit-rate
      const fires = (firesRes.data ?? []) as Array<{ id: string; conid: number | string; fire_ts: string }>;
      const liveFiredConids = new Set<number>();
      const firesByConid = new Map<number, string[]>(); // conid → fire ids (30d)
      for (const f of fires) {
        const c = Number(f.conid);
        if (Date.parse(f.fire_ts) >= liveCutoff) liveFiredConids.add(c);
        (firesByConid.get(c) ?? firesByConid.set(c, []).get(c)!).push(f.id);
      }

      // 3) outcomes at the kind's offset → per-conid rolling hit-rate
      const fireIds = fires.map((f) => f.id);
      const outcomeByFire = new Map<string, number>(); // fire_id → return_pct at offset
      if (fireIds.length > 0) {
        const outRes = await supabase
          .from('signal_outcomes')
          .select('fire_id, t_offset, return_pct')
          .eq('t_offset', offset)
          .in('fire_id', fireIds);
        for (const o of (outRes.data ?? []) as Array<{ fire_id: string; return_pct: number | string | null }>) {
          const rp = num(o.return_pct);
          if (rp != null) outcomeByFire.set(o.fire_id, rp);
        }
      }
      const hitRateByConid = new Map<number, { pct: number; sample: number }>();
      for (const [c, ids] of firesByConid) {
        let graded = 0;
        let hits = 0;
        for (const id of ids) {
          const rp = outcomeByFire.get(id);
          if (rp == null) continue;
          graded++;
          if (rp >= thresholdPct) hits++;
        }
        if (graded > 0) hitRateByConid.set(c, { pct: (hits / graded) * 100, sample: graded });
      }

      // 4) compose rows + composite rank
      const out: VirtualRow[] = [];
      for (const [conid, a] of acc) {
        const q = qByConid.get(conid);
        // No quote → no symbol/price to render. Skip (engine hasn't priced it yet).
        if (!q || !q.symbol) continue;
        const band = bandByConid.get(conid) ?? null;
        const hitRate = hitRateByConid.get(conid) ?? null;
        const justFired = liveFiredConids.has(conid);
        const hr = hitRate?.pct ?? 0;
        const news = newsByConid.get(conid) ?? null;
        const newsTerm = (news?.score ?? 0) * NEWS_RANK_SCALE; // good lifts / bad sinks

        let score: number;
        if (kind === 'intraday') {
          const w = INTRADAY_WEIGHTS;
          score =
            w.character * a.character +
            w.catalyst * a.catalyst +
            w.fired * (justFired ? 100 : 0) +
            w.hitRate * hr +
            w.news * newsTerm;
        } else {
          const w = SWING_WEIGHTS;
          score =
            w.postEarnings * a.postEarnings +
            w.catalyst * a.catalyst +
            w.character * a.character +
            w.fired * (justFired ? 100 : 0) +
            w.hitRate * hr +
            w.news * newsTerm;
        }

        out.push({
          conid,
          symbol: q.symbol,
          companyName: null,
          price: num(q.canonical_price),
          source: q.canonical_source ?? null,
          todayChangePct: num(q.today_change_pct),
          todayOpen: num(q.today_open),
          sparklineCloses: Array.isArray(q.sparkline_closes)
            ? (q.sparkline_closes as unknown[]).map((v) => Number(v)).filter((v) => Number.isFinite(v))
            : null,
          reasons: orderReasons(a.reasons),
          justFired,
          band: band ? { sessionRegime: band.sessionRegime, volScalar: band.volScalar, lowBand: band.lowBand, highBand: band.highBand } : null,
          hitRate,
          news,
          score,
        });
      }

      out.sort((x, y) => y.score - x.score);
      if (alive) {
        setRows(out.slice(0, VIRTUAL_LIST_TOP_N));
        setLoading(false);
      }
    }

    void load();

    // Realtime on the rank-affecting tables. Debounced so a burst of quote /
    // fire writes coalesces into one reload (the union is ~250-300 conids).
    const scheduleReload = () => {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
      }, 1500);
    };
    const ch = supabase
      .channel(`virtual-list-${kind}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'curated_list' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'trait_scores' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'band_state' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes' }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'news_sentiment' }, scheduleReload)
      .subscribe();

    return () => {
      alive = false;
      if (reloadTimer) clearTimeout(reloadTimer);
      void supabase.removeChannel(ch);
    };
  }, [kind]);

  return { rows, loading, asof, stale };
}

const REASON_ORDER: ReasonChip[] = ['dip', 'catalyst', 'post-earnings'];
function orderReasons(s: Set<ReasonChip>): ReasonChip[] {
  return REASON_ORDER.filter((r) => s.has(r));
}
