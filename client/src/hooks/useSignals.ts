import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

export type SignalDirection = 'sell' | 'buy' | 'no_signal';

// One step of a playbook: an action at a level, with its own confidence + why.
// `status`/`actual` are runtime fields written by Batch 14h live tracking
// (absent until then).
export interface PlaybookLeg {
  action: 'sell' | 'buy';
  price: number;
  condition: 'at_or_above' | 'at_or_below' | 'about';
  confidence: number;
  reasoning: string;
  status?: 'pending' | 'hit' | 'missed';
  actual?: number | null;
}

// The full single-direction playbook (mirrors the `playbook jsonb` column).
export interface Playbook {
  direction: 'sell' | 'buy';
  signalQuality: number;
  motivation: string;
  horizon: 'intraday' | 'multiday';
  horizonWindow: string | null;
  legs: PlaybookLeg[];
}

// One active (non-superseded) signal row — the single-direction playbook of the
// latest analysis. leg[0] is mirrored into priceRange*/optimalPrice; the full
// ordered legs + horizon live on `playbook`.
export interface ActiveSignal {
  id: string;
  analysisId: string | null;
  type: SignalDirection;
  quality: number;
  motivation: string | null;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  optimalPrice: number | null;
  rationale: string | null;
  playbook: Playbook | null;
  analyzedAt: string;
  expiresAt: string | null;
}

// Shared context for the latest analysis (the narrative + indicator readings
// both direction rows reference).
export interface SignalAnalysis {
  analysisId: string;
  reasoning: string | null;
  readings: Record<string, unknown>;
  analyzedAt: string;
}

export interface UseSignalsResult {
  analysis: SignalAnalysis | null;
  signals: ActiveSignal[];
  previousCount: number;
  isLoading: boolean;
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

interface DbSignal {
  id: string;
  symbol: string;
  analysis_id: string | null;
  signal_type: SignalDirection;
  signal_quality: number | string;
  motivation: string | null;
  price_range_low: number | string | null;
  price_range_high: number | string | null;
  optimal_price: number | string | null;
  rationale: string | null;
  playbook: Playbook | null;
  analyzed_at: string;
  expires_at: string | null;
}

function rowToSignal(r: DbSignal): ActiveSignal {
  return {
    id: r.id,
    analysisId: r.analysis_id,
    type: r.signal_type,
    quality: num(r.signal_quality) ?? 0,
    motivation: r.motivation,
    priceRangeLow: num(r.price_range_low),
    priceRangeHigh: num(r.price_range_high),
    optimalPrice: num(r.optimal_price),
    rationale: r.rationale,
    playbook: r.playbook ?? null,
    analyzedAt: r.analyzed_at,
    expiresAt: r.expires_at,
  };
}

// Loads the latest non-superseded analysis for (user, symbol) — its 1-2 signal
// rows plus the shared `analyses` context — and re-pulls on any `signals`
// Realtime change (the completion of an analysis inserts rows here).
export function useSignals(symbol: string | undefined): UseSignalsResult {
  const [analysis, setAnalysis] = useState<SignalAnalysis | null>(null);
  const [signals, setSignals] = useState<ActiveSignal[]>([]);
  const [previousCount, setPreviousCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!symbol) {
      setSignals([]);
      setAnalysis(null);
      setIsLoading(false);
      return;
    }
    const sym = symbol.toUpperCase();
    let alive = true;

    async function load() {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) {
        if (alive) {
          setSignals([]);
          setAnalysis(null);
          setIsLoading(false);
        }
        return;
      }

      const { data: sigRows } = await supabase
        .from('signals')
        .select('*')
        .eq('user_id', userId)
        .eq('symbol', sym)
        .is('superseded_by_analysis_id', null)
        .order('analyzed_at', { ascending: false });

      if (!alive) return;

      const active = (sigRows ?? []) as DbSignal[];
      const mapped = active.map(rowToSignal);
      setSignals(mapped);

      const analysisId = mapped[0]?.analysisId ?? null;
      if (analysisId) {
        const { data: aRow } = await supabase
          .from('analyses')
          .select('analysis_id, reasoning, indicator_snapshot, analyzed_at')
          .eq('analysis_id', analysisId)
          .maybeSingle();
        if (alive && aRow) {
          const snap = (aRow.indicator_snapshot ?? {}) as { readings?: Record<string, unknown> };
          setAnalysis({
            analysisId: aRow.analysis_id,
            reasoning: aRow.reasoning,
            readings: snap.readings ?? {},
            analyzedAt: aRow.analyzed_at,
          });
        }
      } else if (alive) {
        setAnalysis(null);
      }

      const { count } = await supabase
        .from('analyses')
        .select('analysis_id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('symbol', sym);
      if (alive) setPreviousCount(Math.max(0, (count ?? 0) - 1));

      if (alive) setIsLoading(false);
    }

    void load();

    const channel = supabase
      .channel(`signals-${sym}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, () => {
        void load();
      })
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [symbol]);

  return { analysis, signals, previousCount, isLoading };
}

export interface UseAllSignalsResult {
  signalsBySymbol: Record<string, ActiveSignal[]>;
  isLoading: boolean;
}

// List-level variant: loads every active (non-superseded) signal for the user
// grouped by symbol, with a single `signals` Realtime subscription. Lets the
// portfolio list render SignalPills per card without one subscription per card.
export function useAllSignals(): UseAllSignalsResult {
  const [signalsBySymbol, setSignalsBySymbol] = useState<Record<string, ActiveSignal[]>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) {
        if (alive) {
          setSignalsBySymbol({});
          setIsLoading(false);
        }
        return;
      }
      const { data } = await supabase
        .from('signals')
        .select('*')
        .eq('user_id', userId)
        .is('superseded_by_analysis_id', null)
        .order('analyzed_at', { ascending: false });
      if (!alive) return;
      const map: Record<string, ActiveSignal[]> = {};
      for (const r of (data ?? []) as DbSignal[]) {
        (map[r.symbol] ??= []).push(rowToSignal(r));
      }
      setSignalsBySymbol(map);
      setIsLoading(false);
    }

    void load();

    const channel = supabase
      .channel('signals-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signals' }, () => {
        void load();
      })
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, []);

  return { signalsBySymbol, isLoading };
}
