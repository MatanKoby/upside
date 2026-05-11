import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';
import { getPnlColor } from '../../utils/calculations';

export function SummaryStrip({
  portfolioValue,
  mtdReturn,
  mtdReturnPercent,
}: {
  portfolioValue: number;
  mtdReturn: number;
  mtdReturnPercent: number;
}) {
  const tone = getPnlColor(mtdReturnPercent);
  return (
    <div className="summary-strip">
      <div className="summary-card">
        <div className="summary-label">Portfolio value</div>
        <div className="summary-value">{formatCurrency(portfolioValue, false)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">MTD return</div>
        <div className={`summary-value summary-value-${tone}`}>
          {formatSignedCurrency(mtdReturn, false)} ({formatSignedPercent(mtdReturnPercent)})
        </div>
      </div>
    </div>
  );
}
