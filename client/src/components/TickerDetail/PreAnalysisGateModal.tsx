import { IconAlertTriangle } from '@tabler/icons-react';
import type { RiskFlagRow } from '../../utils/riskFlags';
import { dominantFlag, flagExplanation, orderedFlags } from '../../utils/riskFlags';

// DANGER modal fronting Analyze / Refine on a CRITICAL ticker (Batch R2).
// Explicit confirm BEFORE the normal two-step friction runs — friction, not a
// silent override; the BE signalQuality clamp is the backstop if the user
// proceeds. WARNING never gates. See spec/screens/ticker-detail.md →
// Pre-analysis gate.
export function PreAnalysisGateModal({
  symbol,
  row,
  onConfirm,
  onCancel,
}: {
  symbol: string;
  row: RiskFlagRow;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const lead = flagExplanation(dominantFlag(row));
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="danger-gate" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <div className="danger-gate-head">
          <IconAlertTriangle size={20} stroke={2} />
          <h2>{symbol} — high reversal risk</h2>
        </div>
        <p className="danger-gate-lead">{lead}</p>
        <ul className="danger-gate-flags">
          {orderedFlags(row).map((f) => (
            <li key={f.key}>{flagExplanation(f)}</li>
          ))}
        </ul>
        <p className="danger-gate-note">
          Momentum plays have high reversal risk. Any signal generated is confidence-capped. Proceed?
        </p>
        <div className="danger-gate-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
            Proceed anyway
          </button>
        </div>
      </div>
    </div>
  );
}
