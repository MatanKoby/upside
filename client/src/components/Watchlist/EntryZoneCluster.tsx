// Compact entry-zone display for a watchlist row.
//
// Default render: only the OVERNIGHT (middle) chip — that's the typical
// "next day" horizon, less noisy than three pills on every row. Hover (desktop)
// or tap (mobile) opens a bubble showing all three horizons (intraday /
// overnight / multiday) with their reasoning + confidence + the
// overbought-tightened flag. Tapping a chip inside the bubble triggers
// `onPromote` so the user can "promote" the auto-zone into a manual marker
// (pre-filled add-marker sheet) — turns auto-suggestions into user-confirmed
// markers, the source of truth for what the user actually tracks.

import { useEffect, useRef, useState } from 'react';
import type { EntryZoneRow, Horizon } from '../../hooks/useWatchlistData';

const HORIZON_FULL: Record<Horizon, string> = {
  intraday:  'Today',
  overnight: 'Days',
  multiday:  'Weeks',
};

interface Props {
  zones: Partial<Record<Horizon, EntryZoneRow>>;
  // Called when the user taps a specific horizon's chip to convert it to a
  // manual marker. Receives the zone they tapped so the caller can seed the
  // MarkerSheet.
  onPromote: (zone: EntryZoneRow) => void;
}

export function EntryZoneCluster({ zones, onPromote }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const middle = zones.overnight ?? zones.intraday ?? zones.multiday;
  if (!middle) return null;

  // Render order in the popover: shortest → longest horizon. Skip any that
  // didn't produce a zone this cycle.
  const ordered = (['intraday', 'overnight', 'multiday'] as Horizon[])
    .map((h) => ({ horizon: h, zone: zones[h] }))
    .filter((row): row is { horizon: Horizon; zone: EntryZoneRow } => Boolean(row.zone));

  return (
    <div
      ref={ref}
      className="zone-cluster"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="zone-chip zone-chip-overnight"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Tap to see all entry zones"
      >
        <span className="zone-chip-horizon">O</span>
        <span className="zone-chip-price">${middle.price}</span>
      </button>

      {open && (
        <div className="zone-popover" onClick={(e) => e.stopPropagation()}>
          <div className="zone-popover-title">Entry zones — tap to promote to marker</div>
          {ordered.map(({ horizon, zone }) => (
            <button
              key={horizon}
              type="button"
              className={`zone-popover-row zone-popover-${horizon}`}
              onClick={() => {
                setOpen(false);
                onPromote(zone);
              }}
            >
              <div className="zone-popover-row-head">
                <span className="zone-popover-row-tag">{HORIZON_FULL[horizon]}</span>
                <span className="zone-popover-row-price">${zone.price}</span>
                <span className="zone-popover-row-conf">{zone.confidence}%</span>
              </div>
              <div className="zone-popover-row-reason">
                {zone.reasoning}
                {zone.overbought_tightened && ' · overbought-tightened'}
                {zone.trend_regime && ` · trend: ${zone.trend_regime}`}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
