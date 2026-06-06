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
  const { rows, loading } = useVirtualList(kind);
  const navigate = useNavigate();

  if (loading) {
    return <p className="watchlist-empty-msg">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <p className="watchlist-empty-msg">
        {kind === 'intraday' ? 'Intraday' : 'Swing'} list is still warming up — the screener and dip-bounce
        engine populate it once they've run with IB connected.
      </p>
    );
  }
  return (
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
  );
}
