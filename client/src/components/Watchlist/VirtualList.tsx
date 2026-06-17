import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualList, type VirtualRow } from '../../hooks/useVirtualList';
import type { VirtualKind } from '../../config/virtualList';
import type { RiskFlagRow } from '../../utils/riskFlags';
import { entryTemperature, factorFlags, TEMP_ORDER, type EntryTemp, type Factor } from '../../utils/entryTemperature';
import { VirtualListRow } from './VirtualListRow';
import { WhySheet } from './WhySheet';

// Body for an Upside-curated virtual tab (Intraday / Swing). A living top-N
// leaderboard, now surfaced **hottest-first** (Batch X12): each row carries a
// live entry-temperature verdict (🔥/🟡/🧊), a 🟢/🔴 factor-flag tally, and a
// one-tap ⓘ "why" sheet. Tap a row → TickerDetail; long-press → add-marker
// sheet prefilled at the walking-band low. See spec/screens/watchlist.md →
// Reading a row.

interface Decorated {
  row: VirtualRow;
  risk: RiskFlagRow | null;
  temp: EntryTemp;
  reason: string;
  tailwinds: Factor[];
  headwinds: Factor[];
}

export function VirtualList({
  kind,
  riskByConid,
  onAddMarker,
}: {
  kind: VirtualKind;
  riskByConid: Map<number, RiskFlagRow>;
  onAddMarker: (row: VirtualRow) => void;
}) {
  const { rows, loading, asof, stale } = useVirtualList(kind);
  const navigate = useNavigate();
  const [hotOnly, setHotOnly] = useState(true);
  const [why, setWhy] = useState<{ item: Decorated; rank: number; total: number } | null>(null);

  // Decorate each row with its live temperature + factor flags, then sort
  // temperature tier first (🔥→🟡→cool→🧊). The hook already returns rows
  // score-desc, and Array.sort is stable, so the composite stays the within-tier
  // tiebreaker for free.
  const decorated = useMemo<Decorated[]>(() => {
    const items: Decorated[] = rows.map((row) => {
      const risk = riskByConid.get(row.conid) ?? null;
      const sig = { ...row, risk };
      const { temp, reason } = entryTemperature(sig);
      const { tailwinds, headwinds } = factorFlags(sig);
      return { row, risk, temp, reason, tailwinds, headwinds };
    });
    items.sort((a, b) => TEMP_ORDER[a.temp] - TEMP_ORDER[b.temp]);
    return items;
  }, [rows, riskByConid]);

  if (loading) {
    return <p className="watchlist-empty-msg">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="watchlist-empty-msg">
        {kind === 'intraday' ? 'Intraday' : 'Swing'} list is still warming up — it populates after the
        screener + dip-bounce engine run (daily; no IB connection required).
      </p>
    );
  }

  const actionable = decorated.filter((d) => d.temp === 'hot' || d.temp === 'near');
  const coolingCount = decorated.length - actionable.length;
  const shown = hotOnly ? actionable : decorated;

  const today = new Date().toISOString().slice(0, 10);
  const showAge = asof != null && asof !== today;

  return (
    <>
      {stale ? (
        <p className="watchlist-stale-banner" role="status">
          ⚠ Data stale — latest pool is from {formatAsOf(asof)}. Showing it until the next refresh.
        </p>
      ) : showAge ? (
        <p className="watchlist-asof-badge" role="status">as of {formatAsOf(asof)}</p>
      ) : null}

      <div className="virtual-filter-bar">
        <button
          type="button"
          className={`virtual-filter-toggle ${hotOnly ? 'is-active' : ''}`}
          aria-pressed={hotOnly}
          onClick={() => setHotOnly((v) => !v)}
        >
          🔥 Hot &amp; near only
        </button>
        <span className="virtual-filter-count">
          {actionable.length} hot/near · {coolingCount} cooling
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="watchlist-empty">
          <p className="watchlist-empty-msg">No hot setups right now — {coolingCount} cooling.</p>
          <button type="button" className="btn btn-sm" onClick={() => setHotOnly(false)}>
            Show all {decorated.length}
          </button>
        </div>
      ) : (
        <ul className="watchlist-items">
          {shown.map((item, i) => (
            <li key={item.row.conid}>
              <VirtualListRow
                row={item.row}
                risk={item.risk}
                temp={item.temp}
                tailwindCount={item.tailwinds.length}
                headwindCount={item.headwinds.length}
                onTap={() => navigate(`/ticker/${encodeURIComponent(item.row.symbol)}`)}
                onLongPress={() => onAddMarker(item.row)}
                onWhy={() => setWhy({ item, rank: i + 1, total: shown.length })}
              />
            </li>
          ))}
        </ul>
      )}

      {why && (
        <WhySheet
          symbol={why.item.row.symbol}
          kind={kind}
          temp={why.item.temp}
          reason={why.item.reason}
          tailwinds={why.item.tailwinds}
          headwinds={why.item.headwinds}
          rankDrivers={why.item.row.rankDrivers}
          rank={why.rank}
          total={why.total}
          onClose={() => setWhy(null)}
        />
      )}
    </>
  );
}

// Fixed dd/mm — locale-independent (no browser-locale month names). asof is a
// plain YYYY-MM-DD pool date.
function formatAsOf(asof: string | null): string {
  if (!asof) return '—';
  const [, m, d] = asof.split('-');
  return m && d ? `${d}/${m}` : asof;
}
