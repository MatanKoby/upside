import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconArrowLeft } from '@tabler/icons-react';
import { getPnlColor } from '../../utils/calculations';
import { formatCurrency, formatSignedCurrency, formatSignedPercent } from '../../utils/formatters';
import type { TickerDetailData } from '../../types';
import type { ChartTimeframe } from '../../data/mockChartData';
import { TodayRange } from './TodayRange';
import { MarketStats } from './MarketStats';
import { ChartControls, type ChartMode, type OverlayKey } from './ChartControls';
import { TimeframeBar } from './TimeframeBar';
import { SignalSection } from './SignalSection';
import { PositionStats } from './PositionStats';
import { IndicatorsSection } from './IndicatorsSection';
import { CollapsibleSection } from '../common/CollapsibleSection';
import { PriceChart } from './PriceChart';
import { useSignals } from '../../hooks/useSignals';
import { SignalPill } from '../primitives/SignalPill';

export function TickerDetail({ detail }: { detail: TickerDetailData }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<ChartMode>('line');
  const [timeframe, setTimeframe] = useState<ChartTimeframe>('1D');
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({
    vwap: true,
    volume: true,
    rsi: false,
  });
  const tone = useMemo(() => getPnlColor(detail.todayChangePercent), [detail.todayChangePercent]);

  // Lifted here (rather than inside SignalSection) so the same subscription
  // feeds both the section body and the collapsed-header pill row.
  const signalsResult = useSignals(detail.symbol);
  const actionableSignals = signalsResult.signals.filter((s) => s.type !== 'no_signal');
  const signalAccessory =
    actionableSignals.length > 0 ? (
      <span className="td-section-pills">
        {actionableSignals.map((s) => (
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
    ) : undefined;

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
      <MarketStats initialStats={detail.marketStats} week52={detail.week52} />

      <section className="td-chart-shell" aria-label="Chart placeholder">
        <PriceChart
          symbol={detail.symbol}
          timeframe={timeframe}
          mode={mode}
          overlays={overlays}
          entryPrice={detail.positionStats?.avgCost}
          entryDate={detail.positionStats?.entryDate ?? undefined}
        />
        <ChartControls
          mode={mode}
          overlays={overlays}
          onModeChange={setMode}
          onOverlayToggle={(overlay) => {
            setOverlays((prev) => ({ ...prev, [overlay]: !prev[overlay] }));
          }}
        />
        <TimeframeBar active={timeframe} onChange={setTimeframe} />
      </section>

      <CollapsibleSection title="Signal" headerAccessory={signalAccessory}>
        <SignalSection symbol={detail.symbol} signalsResult={signalsResult} />
      </CollapsibleSection>

      {detail.positionStats && (
        <CollapsibleSection title="Position stats">
          <PositionStats stats={detail.positionStats} />
        </CollapsibleSection>
      )}

      <CollapsibleSection title="Indicators">
        <IndicatorsSection indicators={detail.indicators} />
      </CollapsibleSection>
    </div>
  );
}
