import { useNavigate } from 'react-router-dom';
import { IconChevronRight, IconArrowUp, IconArrowDown, IconArrowBarToUp } from '@tabler/icons-react';
import { Sparkline } from '../common/Sparkline';
import { Tooltip } from '../common/Tooltip';
import { SignalPill } from '../primitives/SignalPill';
import { useSparkline } from '../../hooks/useSparkline';
import type { ActiveSignal } from '../../hooks/useSignals';
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
import type { Position } from '../../types';

export function PositionCard({
  position,
  totalPortfolioValue,
  signals = [],
}: {
  position: Position;
  totalPortfolioValue: number;
  signals?: ActiveSignal[];
}) {
  const navigate = useNavigate();
  // Prefer real sparkline closes from the BE; fall back to whatever's on the
  // position (kept for mock data compatibility during the wiring transition).
  const fetched = useSparkline(position.symbol);
  const sparklineData = fetched.length > 0 ? fetched : position.sparkline;
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

  const actionable = signals.filter((s) => s.type !== 'no_signal');
  const inZone = position.zoneEnteredAt != null;

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
              {inZone && (
                <Tooltip label="Profit-taking zone — unrealized P&L crossed your profit-taking threshold. Consider analyzing.">
                  <span className="zone-icon" aria-label="In profit-taking zone">
                    <IconArrowBarToUp size={13} stroke={2} />
                  </span>
                </Tooltip>
              )}
              {inZone && position.enteredZoneViaGap && (
                <Tooltip label="Entered the zone outside regular hours (gap) — gap moves often fade at the open.">
                  <span className="gap-badge">GAP</span>
                </Tooltip>
              )}
              {formatPnL(position.unrealizedPnL, position.unrealizedPnLPercent)}
            </div>
            <Sparkline data={sparklineData} />
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
      {actionable.length > 0 && (
        <button className="position-card-signal" onClick={goToDetail} type="button">
          <span className="position-card-pills">
            {actionable.map((s) => (
              <SignalPill
                key={s.id}
                type={s.type}
                quality={s.quality}
                motivation={s.motivation}
                low={s.priceRangeLow}
                high={s.priceRangeHigh}
              />
            ))}
          </span>
          <IconChevronRight size={14} stroke={1.5} className="signal-chevron" />
        </button>
      )}
    </article>
  );
}
