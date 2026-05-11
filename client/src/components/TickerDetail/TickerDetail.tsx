import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { getPnlColor } from '../../utils/calculations';
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';
import type { TickerDetailData } from '../../types';
import { TodayRange } from './TodayRange';
import { MarketStats } from './MarketStats';
import { ChartControls } from './ChartControls';
import { TimeframeBar } from './TimeframeBar';
import { SignalSection } from './SignalSection';
import { PositionStats } from './PositionStats';
import { IndicatorsSection } from './IndicatorsSection';
import { CollapsibleSection } from '../common/CollapsibleSection';

export function TickerDetail({ detail }: { detail: TickerDetailData }) {
  const navigate = useNavigate();
  const tone = useMemo(() => getPnlColor(detail.todayChangePercent), [detail.todayChangePercent]);

  return (
    <div className="ticker-detail-screen">
      <header className="td-header">
        <button type="button" className="td-back" aria-label="Back" onClick={() => navigate(-1)}>
          <IconArrowLeft size={18} />
        </button>
        <div className="td-title-wrap">
          <h1>{detail.symbol}</h1>
          <p>{detail.company}</p>
        </div>
        <div className="td-price-wrap">
          <strong>{formatCurrency(detail.price)}</strong>
          <span className={`pnl-${tone}`}>
            {formatSignedCurrency(detail.todayChange)} ({formatSignedPercent(detail.todayChangePercent)})
          </span>
        </div>
      </header>

      <TodayRange low={detail.dayLow} high={detail.dayHigh} currentRatio={detail.currentInRange} />
      <MarketStats initialStats={detail.marketStats} />

      <section className="td-chart-shell" aria-label="Chart placeholder">
        <div className="td-chart-placeholder">Chart surface reserved for Batch 3</div>
        <ChartControls />
        <TimeframeBar />
      </section>

      <CollapsibleSection title="Signal">
        <SignalSection signal={detail.signal} />
      </CollapsibleSection>

      <CollapsibleSection title="Position stats">
        <PositionStats stats={detail.positionStats} />
      </CollapsibleSection>

      <CollapsibleSection title="Indicators">
        <IndicatorsSection indicators={detail.indicators} />
      </CollapsibleSection>
    </div>
  );
}
