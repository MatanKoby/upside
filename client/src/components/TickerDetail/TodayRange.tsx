import { formatCurrency } from '../../utils/formatters';

export function TodayRange({
  low,
  high,
  currentRatio,
}: {
  low: number;
  high: number;
  currentRatio: number;
}) {
  const dotOffset = `${Math.max(0, Math.min(100, currentRatio * 100))}%`;

  return (
    <section className="td-range">
      <div className="td-range-head">
        <span className="td-range-low">{formatCurrency(low)}</span>
        <span className="td-range-label">Today range</span>
        <span className="td-range-high">{formatCurrency(high)}</span>
      </div>
      <div className="td-range-bar-wrap">
        <div className="td-range-bar" />
        <span className="td-range-current-dot" style={{ left: dotOffset }} />
      </div>
    </section>
  );
}
