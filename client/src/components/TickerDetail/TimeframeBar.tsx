import { useState } from 'react';

const TIMEFRAMES = ['30m', '2h', '1D', '2D', '1W', '1M', '3M', '1Y', '5Y', 'All'] as const;

export function TimeframeBar() {
  const [active, setActive] = useState<(typeof TIMEFRAMES)[number]>('1D');

  return (
    <div className="td-timeframe-bar" role="tablist" aria-label="Timeframe selector">
      {TIMEFRAMES.map((timeframe) => (
        <button
          key={timeframe}
          type="button"
          role="tab"
          aria-selected={active === timeframe}
          className={active === timeframe ? 'td-timeframe-pill is-active' : 'td-timeframe-pill'}
          onClick={() => setActive(timeframe)}
        >
          {timeframe}
        </button>
      ))}
    </div>
  );
}
