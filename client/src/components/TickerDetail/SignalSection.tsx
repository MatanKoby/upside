import type { TickerSignalDetail } from '../../types';

export function SignalSection({ signal }: { signal: TickerSignalDetail }) {
  const label = signal.type === 'buy' ? 'Buy' : signal.type === 'sell' ? 'Sell' : signal.type === 'event' ? 'Event' : 'Watch';

  return (
    <div className="td-signal">
      <div className="td-signal-head">
        <span className={`signal-pill signal-pill-${signal.type}`}>{label} · {signal.confidence}%</span>
        <p>{signal.summary}</p>
      </div>
      <ul className="td-signal-list">
        {signal.rationale.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="td-signal-style-a">Style A: {signal.styleABreakdown}</p>
    </div>
  );
}
