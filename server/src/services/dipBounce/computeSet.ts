// The dip-bounce / band-engine compute set (Batch X1): curated ∪ active-watchlist
// ∪ held. Bounded by the user's visibility choices, so the IB-budget delta from
// widening past curated-only stays small. See spec/signals/curated-list.md →
// Consumers + spec/screens/watchlist.md → Engine coverage.

import { supabase } from '../supabase.js';
import { activeWatchlistOnlyConids } from '../quotes.js';
import { latestCuratedAsof } from '../curatedList/asof.js';

export interface ComputeMember {
  conid: number;
  symbol: string;
  isHeld: boolean;
}

function fin(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function loadComputeSet(): Promise<ComputeMember[]> {
  const db = supabase();
  const byConid = new Map<number, ComputeMember>();
  // Curated portion keys on the LATEST available curated date, not today —
  // the list builds under the latest trait date (Batch X9), which may lag today
  // off-hours. Held + watchlist are date-independent.
  const asof = await latestCuratedAsof();

  // Held positions.
  const { data: pos } = await db.from('positions').select('conid, symbol');
  for (const p of pos ?? []) {
    const c = fin((p as { conid: unknown }).conid);
    if (c != null) byConid.set(c, { conid: c, symbol: String((p as { symbol: unknown }).symbol ?? ''), isHeld: true });
  }

  // Active-watchlist (excluding held).
  const wl = await activeWatchlistOnlyConids(new Set(byConid.keys()));
  for (const { conid, symbol } of wl) {
    if (!byConid.has(conid)) byConid.set(conid, { conid, symbol, isHeld: false });
  }

  // Curated list (latest date) — symbols resolved via universe.real_conid.
  if (asof) {
    const { data: cur } = await db.from('curated_list').select('conid').eq('asof_date', asof);
    const curConids = (cur ?? []).map((r) => fin((r as { conid: unknown }).conid)).filter((c): c is number => c != null);
    const missing = curConids.filter((c) => !byConid.has(c));
    for (let i = 0; i < missing.length; i += 900) {
      const chunk = missing.slice(i, i + 900);
      const { data: u } = await db.from('universe').select('real_conid, symbol').in('real_conid', chunk);
      for (const row of u ?? []) {
        const c = fin((row as { real_conid: unknown }).real_conid);
        if (c != null && !byConid.has(c)) {
          byConid.set(c, { conid: c, symbol: String((row as { symbol: unknown }).symbol ?? ''), isHeld: false });
        }
      }
    }
  }

  return [...byConid.values()];
}
