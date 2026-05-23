import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';
import { getPnlColor } from '../../utils/calculations';

export function SummaryStrip({
  portfolioValue,
  mtdReturn,
  mtdReturnPercent,
}: {
  portfolioValue: number;
  // Null when the api was offline at the first poll of the current month —
  // no anchor was captured, so MTD can't be computed honestly. Renders "—"
  // until the next month rolls over.
  mtdReturn: number | null;
  mtdReturnPercent: number | null;
}) {
  const hasMtd = mtdReturn != null && mtdReturnPercent != null;
  const tone = hasMtd ? getPnlColor(mtdReturnPercent) : 'neutral';
  return (
    <div className="summary-strip">
      <div className="summary-card">
        <div className="summary-label">Portfolio value</div>
        <div className="summary-value">{formatCurrency(portfolioValue, false)}</div>
      </div>
      <div className="summary-card">
        <div className="summary-label">MTD return</div>
        <div
          className={`summary-value summary-value-${tone}`}
          title={hasMtd ? undefined : 'No month-start anchor recorded yet — MTD will populate next month.'}
        >
          {hasMtd
            ? `${formatSignedCurrency(mtdReturn, false)} (${formatSignedPercent(mtdReturnPercent)})`
            : '—'}
        </div>
      </div>
    </div>
  );
}
