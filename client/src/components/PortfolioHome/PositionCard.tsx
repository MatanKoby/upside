import { useNavigate } from 'react-router-dom';
import { IconChevronRight, IconArrowUp, IconArrowDown } from '@tabler/icons-react';
import { Sparkline } from '../common/Sparkline';
import {
  formatCurrency,
  formatSignedCurrency,
  formatSignedPercent,
  formatPnL,
} from '../../utils/formatters';
import {
  getPnlColor,
  getTintOpacity,
  getVwapDelta,
  getPositionWeight,
} from '../../utils/calculations';
import type { Position, Signal } from '../../types';

function signalPillLabel(s: Signal): string {
  switch (s.type) {
    case 'sell': return `Sell · ${s.confidence}%`;
    case 'buy': return `Add · ${s.confidence}%`;
    case 'event': return `Earnings · ${s.daysAway ?? 0}d`;
    case 'watch': return `Watch · ${s.confidence}%`;
  }
}

export function PositionCard({
  position,
  totalPortfolioValue,
}: {
  position: Position;
  totalPortfolioValue: number;
}) {
  const navigate = useNavigate();
  const tone = getPnlColor(position.unrealizedPnLPercent);
  const todayTone = getPnlColor(position.todayChangePercent);
  const tint = getTintOpacity(position.unrealizedPnLPercent);
  const vwap = getVwapDelta(position.currentPrice, position.vwap);
  const weight = getPositionWeight(position.marketValue, totalPortfolioValue);

  const cardStyle = {
    backgroundColor: `rgb(var(--${tone}-rgb) / ${tint})`,
  };
  const weightBarStyle = {
    width: `${weight}%`,
    backgroundColor: `rgb(var(--${tone}-rgb) / ${Math.min(0.22, tint + 0.06)})`,
  };

  const goToDetail = () => navigate(`/ticker/${position.symbol}`);

  return (
    <article className="position-card" style={cardStyle} data-tone={tone}>
      <button className="position-card-body" onClick={goToDetail} type="button">
        <div className="position-card-row">
          <div className="position-card-left">
            <div className="ticker">{position.symbol}</div>
            <div className="company">{position.name}</div>
          </div>
          <div className="position-card-center">
            <div className={`pnl pnl-${tone}`}>
              {formatPnL(position.unrealizedPnL, position.unrealizedPnLPercent)}
            </div>
            <Sparkline data={position.sparkline} />
          </div>
          <div className="position-card-right">
            <div className="price">{formatCurrency(position.currentPrice)}</div>
            <div className={`today pnl-${todayTone}`}>
              {formatSignedCurrency(position.todayChange)} ({formatSignedPercent(position.todayChangePercent)})
            </div>
            <div className={`vwap vwap-${vwap.state}`}>
              {vwap.state === 'above' && <IconArrowUp size={10} stroke={2} />}
              {vwap.state === 'below' && <IconArrowDown size={10} stroke={2} />}
              <span>
                {vwap.state === 'flat' ? '= VWAP' : `${formatSignedPercent(vwap.diffPercent)} VWAP`}
              </span>
            </div>
          </div>
        </div>
        <div className="weight-bar" style={weightBarStyle} aria-hidden="true" />
      </button>
      {position.signal && (
        <button className="position-card-signal" onClick={goToDetail} type="button">
          <span className={`signal-pill signal-pill-${position.signal.type}`}>
            {signalPillLabel(position.signal)}
          </span>
          <span className="signal-summary">{position.signal.summary}</span>
          <IconChevronRight size={14} stroke={1.5} className="signal-chevron" />
        </button>
      )}
    </article>
  );
}
