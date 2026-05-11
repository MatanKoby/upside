import type { IndicatorDetail } from '../../types';

export function IndicatorsSection({ indicators }: { indicators: IndicatorDetail[] }) {
  return (
    <ul className="td-indicators">
      {indicators.map((indicator) => (
        <li key={indicator.name} className="td-indicator-row">
          <div>
            <p>{indicator.name}</p>
            {indicator.note && <span>{indicator.note}</span>}
          </div>
          <span className={`td-indicator-badge is-${indicator.status}`}>{indicator.value}</span>
        </li>
      ))}
    </ul>
  );
}
