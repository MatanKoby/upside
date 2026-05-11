import type { ChartTimeframe } from '../../data/mockChartData';

const TIMEFRAMES: ChartTimeframe[] = ['30m', '2h', '1D', '2D', '1W', '1M', '3M', '1Y', '5Y', 'All'];

export function TimeframeBar({
  active,
  onChange,
}: {
  active: ChartTimeframe;
  onChange: (timeframe: ChartTimeframe) => void;
}) {
  return (
    <div className="td-timeframe-bar" role="tablist" aria-label="Timeframe selector">
      {TIMEFRAMES.map((timeframe) => (
        <button
          key={timeframe}
          type="button"
          role="tab"
          aria-selected={active === timeframe}
          className={active === timeframe ? 'td-timeframe-pill is-active' : 'td-timeframe-pill'}
          onClick={() => onChange(timeframe)}
        >
          {timeframe}
        </button>
      ))}
    </div>
  );
}
