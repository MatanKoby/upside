import { IconAlertTriangle } from '@tabler/icons-react';
import type { RiskFlagRow } from '../../utils/riskFlags';
import { dominantFlag, flagBadgeLabel } from '../../utils/riskFlags';

// The danger pill on a TickerCard (Portfolio + Watchlist) — distinct from the
// signal pill, renders FIRST in the signal+badge row. Red for CRITICAL, amber
// for WARNING; labelled with the dominant flag + "+N" when flags stack. Never
// truncated (same policy as signal pills). See spec/screens/portfolio.md →
// Danger badge. Tap handling lives on the parent card (opens TickerDetail).
export function DangerBadge({ row, compact = false }: { row: RiskFlagRow; compact?: boolean }) {
  if (row.flags.length === 0) return null;
  const label = flagBadgeLabel(dominantFlag(row));
  const extra = row.flags.length - 1;
  return (
    <span
      className={`danger-badge danger-badge-${row.severity}${compact ? ' danger-badge-compact' : ''}`}
      title={`${row.flags.length} risk flag${row.flags.length === 1 ? '' : 's'} · ${row.severity.toUpperCase()}`}
    >
      <IconAlertTriangle size={compact ? 10 : 11} stroke={2} />
      <span className="danger-badge-label">{label}</span>
      {extra > 0 && <span className="danger-badge-extra">+{extra}</span>}
    </span>
  );
}
