import type { PositionStatsDetail } from '../../types';
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';

// Days-held + %/day inherit the provenance of the entry date. When source
// is 'observed', they're floors: the real entry happened on-or-before, but we
// can't prove how much earlier (IB only exposes 90 days of transaction
// history). Title attribute carries the explanation until the Tooltip
// primitive lands in Batch 14c.
const SOURCE_NOTE: Record<PositionStatsDetail['daysHeldSource'], string> = {
  ib_transactions: 'Exact entry date deduced from IB transaction history.',
  observed:
    'Floor — based on when Upside first observed this position. Real entry may be earlier (IB only exposes 90 days of fills).',
};

export function PositionStats({ stats }: { stats: PositionStatsDetail }) {
  const note = SOURCE_NOTE[stats.daysHeldSource];
  const isFloor = stats.daysHeldSource === 'observed';
  const daysText = stats.daysHeld > 0 ? `${isFloor ? '≥' : ''}${stats.daysHeld}d` : '—';
  const perDayText =
    stats.dailyReturnPercent != null
      ? `${isFloor ? '≤' : ''}${formatSignedPercent(stats.dailyReturnPercent)}/d`
      : '—';
  return (
    <dl className="td-stats-grid">
      <div><dt>Shares</dt><dd>{stats.shares}</dd></div>
      <div><dt>Avg cost</dt><dd>{formatCurrency(stats.avgCost)}</dd></div>
      <div><dt>P&L</dt><dd>{formatSignedCurrency(stats.unrealizedPnL, false)} ({formatSignedPercent(stats.unrealizedPnLPercent)})</dd></div>
      <div><dt>Day %</dt><dd>{formatSignedPercent(stats.dayPnLPercent)}</dd></div>
      <div><dt>Portfolio wt</dt><dd>{stats.portfolioWeightPercent.toFixed(1)}%</dd></div>
      <div><dt>Contribution</dt><dd>{stats.contributionPercent.toFixed(1)}%</dd></div>
      <div><dt>Market value</dt><dd>{formatCurrency(stats.marketValue)}</dd></div>
      <div><dt>Day P&L</dt><dd>{formatSignedCurrency(stats.dayPnL)}</dd></div>
      <div><dt>Days held</dt><dd title={note}>{daysText}</dd></div>
      <div><dt>Return / day</dt><dd title={note}>{perDayText}</dd></div>
    </dl>
  );
}
