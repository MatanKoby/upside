// useRiskFlags — risk-flag rows for the danger badge + TickerDetail section
// (Batch R2). Pure FE consumer of R1's `risk_flags` table (conid-keyed,
// instrument-scoped — no user_id, same as band_state / intraday_stats).
//
// A conid can have rows for several recent asof_dates (the cron writes a new
// row per day and 7-day retention trails them); a flag's row is deleted the day
// its conditions clear. So "current state" = the row with the latest asof_date
// for that conid. Both hooks reduce to that.

import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import type { ActiveFlag, RiskFlagRow, RiskSeverity } from '../utils/riskFlags';

interface DbRiskFlag {
  conid: number | string;
  asof_date: string;
  severity: RiskSeverity;
  flags: ActiveFlag[] | null;
}

function toRow(r: DbRiskFlag): RiskFlagRow {
  return {
    conid: typeof r.conid === 'number' ? r.conid : Number(r.conid),
    asofDate: r.asof_date,
    severity: r.severity,
    flags: Array.isArray(r.flags) ? r.flags : [],
  };
}

// Keep the latest-asof row per conid, dropping empties (a row should always
// carry ≥1 flag, but guard anyway so a stale empty never renders a badge).
function latestPerConid(rows: DbRiskFlag[]): Map<number, RiskFlagRow> {
  const out = new Map<number, RiskFlagRow>();
  for (const raw of rows) {
    const row = toRow(raw);
    if (row.flags.length === 0) continue;
    const prev = out.get(row.conid);
    if (!prev || row.asofDate > prev.asofDate) out.set(row.conid, row);
  }
  return out;
}

const SELECT = 'conid, asof_date, severity, flags';

// Single-conid lookup for TickerDetail (section + pre-analysis gate).
export function useRiskFlags(conid: number | null | undefined): { loading: boolean; row: RiskFlagRow | null } {
  const [state, setState] = useState<{ loading: boolean; row: RiskFlagRow | null }>({ loading: true, row: null });

  useEffect(() => {
    if (conid == null) {
      setState({ loading: false, row: null });
      return;
    }
    let alive = true;

    async function load() {
      const { data } = await supabase
        .from('risk_flags')
        .select(SELECT)
        .eq('conid', conid)
        .order('asof_date', { ascending: false })
        .limit(1);
      if (!alive) return;
      const rows = (data ?? []) as DbRiskFlag[];
      const row = rows[0] ? toRow(rows[0]) : null;
      setState({ loading: false, row: row && row.flags.length > 0 ? row : null });
    }

    void load();

    const ch = supabase
      .channel(`risk-flags-${conid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'risk_flags' }, () => void load())
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, [conid]);

  return state;
}

// List variant for the Portfolio / Watchlist card badges — one Realtime sub for
// all conids, mirroring useAllSignals. Returns a conid → row map.
export function useAllRiskFlags(): { loading: boolean; byConid: Map<number, RiskFlagRow> } {
  const [byConid, setByConid] = useState<Map<number, RiskFlagRow>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;

    async function load() {
      const { data } = await supabase.from('risk_flags').select(SELECT);
      if (!alive) return;
      setByConid(latestPerConid((data ?? []) as DbRiskFlag[]));
      setLoading(false);
    }

    void load();

    const ch = supabase
      .channel('risk-flags-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'risk_flags' }, () => void load())
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, []);

  return { loading, byConid };
}
