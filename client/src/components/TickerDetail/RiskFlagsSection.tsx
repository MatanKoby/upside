import type { RiskFlagRow } from '../../utils/riskFlags';
import { flagExplanation, flagName, flagThreshold, orderedFlags } from '../../utils/riskFlags';

// Body of the TickerDetail "Risk flags" collapsible (Batch R2). One row per
// active flag: name · plain-language explanation · the threshold that fired ·
// "since <date>". See spec/screens/ticker-detail.md → Risk flags.
export function RiskFlagsSection({ row }: { row: RiskFlagRow }) {
  return (
    <ul className="risk-flags-list">
      {orderedFlags(row).map((f) => {
        const threshold = flagThreshold(f);
        return (
          <li key={f.key} className="risk-flag-row">
            <div className="risk-flag-head">
              <span className="risk-flag-name">{flagName(f.key)}</span>
              <span className="risk-flag-since">since {f.since}</span>
            </div>
            <p className="risk-flag-explain">{flagExplanation(f)}</p>
            {threshold && <span className="risk-flag-threshold">{threshold}</span>}
          </li>
        );
      })}
    </ul>
  );
}

// Right-aligned header chip for the collapsed section — severity + count.
export function RiskFlagsAccessory({ row }: { row: RiskFlagRow }) {
  const n = row.flags.length;
  return (
    <span className={`risk-sev risk-sev-${row.severity}`}>
      ⚠ {n} · {row.severity.toUpperCase()}
    </span>
  );
}
