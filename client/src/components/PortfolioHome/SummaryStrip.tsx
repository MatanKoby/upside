import { formatCurrency } from '../../utils/formatters';

// MTD card removed 2026-05-29 per user direction — not useful in the current
// workflow. The strip now carries portfolio value only. The Redis-cached
// month-start anchor + GET /api/portfolio/summary `mtdReturn` field stay on
// the BE for now in case we want to bring this back; nothing else consumes it.
export function SummaryStrip({ portfolioValue }: { portfolioValue: number }) {
  return (
    <div className="summary-strip">
      <div className="summary-card">
        <div className="summary-label">Portfolio value</div>
        <div className="summary-value">{formatCurrency(portfolioValue, false)}</div>
      </div>
    </div>
  );
}
