import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Header } from '../components/PortfolioHome/Header';
import { SummaryStrip } from '../components/PortfolioHome/SummaryStrip';
import { SortBar } from '../components/PortfolioHome/SortBar';
import { PositionList } from '../components/PortfolioHome/PositionList';
import { usePositions } from '../hooks/usePositions';
import { useAllSignals } from '../hooks/useSignals';
import { useAllRiskFlags } from '../hooks/useRiskFlags';
import type { MarketSessionState } from '../hooks/useMarketSession';
import type { SortKey } from '../types';

export default function PortfolioHome() {
  const [sort, setSort] = useState<SortKey>('signals');
  const session = useOutletContext<MarketSessionState>();
  const { positions, isLoading } = usePositions();
  const { signalsBySymbol } = useAllSignals();
  const { byConid: riskByConid } = useAllRiskFlags();

  // Portfolio value is computed FE-side from the live `positions` rows so it
  // ticks instantly on Realtime updates. MTD card was removed 2026-05-29
  // (user direction) — the BE summary endpoint stays available if we want it
  // back, but no consumer reads it now.
  const portfolioValue = positions.reduce((acc, p) => acc + p.marketValue, 0);

  return (
    <div className="portfolio-home">
      <Header
        marketPeriod={session.marketPeriod}
        sessionStatus={session.session}
        onIbChange={session.refresh}
      />
      <SummaryStrip portfolioValue={portfolioValue} />
      <SortBar value={sort} onChange={setSort} />
      {isLoading ? (
        <div className="positions-loading">Loading positions…</div>
      ) : positions.length === 0 ? (
        <div className="positions-empty">
          No positions yet. Once your IB session is connected, your holdings will appear here.
        </div>
      ) : (
        <PositionList
          positions={positions}
          sort={sort}
          totalPortfolioValue={portfolioValue}
          signalsBySymbol={signalsBySymbol}
          riskByConid={riskByConid}
        />
      )}
    </div>
  );
}
