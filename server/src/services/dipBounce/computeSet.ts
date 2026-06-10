// The dip-bounce / band-engine compute set (Batch X1): curated ∪ active-watchlist
// ∪ held. Bounded by the user's visibility choices, so the IB-budget delta from
// widening past curated-only stays small. See spec/signals/curated-list.md →
// Consumers + spec/screens/watchlist.md → Engine coverage.

import { activeWatchlistOnlyConids } from '../quotes.js';
import { latestCuratedAsof } from '../curatedList/asof.js';
import { curatedListTableModule } from '../../db/curatedListTableModule.js';
import { universeTableModule } from '../../db/universeTableModule.js';
import { positionsTableModule } from '../../db/positionsTableModule.js';

export interface ComputeMember {
  conid: number;
  symbol: string;
  isHeld: boolean;
}

export async function loadComputeSet(): Promise<ComputeMember[]> {
  const byConid = new Map<number, ComputeMember>();
  // Curated portion keys on the LATEST available curated date, not today —
  // the list builds under the latest trait date (Batch X9), which may lag today
  // off-hours. Held + watchlist are date-independent.
  const asof = await latestCuratedAsof();

  // Held positions.
  for (const p of await positionsTableModule.getAllHeldConidSymbols().catch(() => [])) {
    byConid.set(p.conid, { conid: p.conid, symbol: p.symbol, isHeld: true });
  }

  // Active-watchlist (excluding held).
  const wl = await activeWatchlistOnlyConids(new Set(byConid.keys()));
  for (const { conid, symbol } of wl) {
    if (!byConid.has(conid)) byConid.set(conid, { conid, symbol, isHeld: false });
  }

  // Curated list (latest date) — symbols resolved via universe.real_conid.
  if (asof) {
    const curConids = await curatedListTableModule.getConidsByDate(asof);
    const missing = curConids.filter((c) => !byConid.has(c));
    for (const row of await universeTableModule.getByRealConids(missing)) {
      if (row.realConid != null && !byConid.has(row.realConid)) {
        byConid.set(row.realConid, { conid: row.realConid, symbol: row.symbol, isHeld: false });
      }
    }
  }

  return [...byConid.values()];
}
