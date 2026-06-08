import { useNavigate } from 'react-router-dom';
import { useVirtualList, type VirtualRow } from '../../hooks/useVirtualList';
import type { VirtualKind } from '../../config/virtualList';
import type { RiskFlagRow } from '../../utils/riskFlags';
import { VirtualListRow } from './VirtualListRow';

// Body for an Upside-curated virtual tab (Intraday / Swing). A living top-N
// leaderboard of the dip-bounce track's output. Tap a row → TickerDetail;
// long-press → add-marker sheet prefilled at the walking-band low (the dip-buy
// level). See spec/screens/watchlist.md → Upside-curated virtual lists.

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
      <ul className="watchlist-items">
        {rows.map((row) => (
          <li key={row.conid}>
            <VirtualListRow
              row={row}
              risk={riskByConid.get(row.conid) ?? null}
              onTap={() => navigate(`/ticker/${encodeURIComponent(row.symbol)}`)}
              onLongPress={() => onAddMarker(row)}
            />
          </li>
        ))}
      </ul>
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
