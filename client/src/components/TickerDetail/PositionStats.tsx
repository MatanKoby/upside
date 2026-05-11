import type { PositionStatsDetail } from '../../types';
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';

export function PositionStats({ stats }: { stats: PositionStatsDetail }) {
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
      <div><dt>Days held</dt><dd>{stats.daysHeld}d</dd></div>
    </dl>
  );
}
