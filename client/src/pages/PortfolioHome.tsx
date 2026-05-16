import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Header } from '../components/PortfolioHome/Header';
import { SummaryStrip } from '../components/PortfolioHome/SummaryStrip';
import { SortBar } from '../components/PortfolioHome/SortBar';
import { PositionList } from '../components/PortfolioHome/PositionList';
import { usePositions } from '../hooks/usePositions';
import type { MarketSessionState } from '../hooks/useMarketSession';
import type { SortKey } from '../types';

export default function PortfolioHome() {
  const [sort, setSort] = useState<SortKey>('signals');
  const session = useOutletContext<MarketSessionState>();
  const { positions, isLoading } = usePositions();

  const portfolioValue = positions.reduce((acc, p) => acc + p.marketValue, 0);

  // MTD return is sourced from IB's account summary endpoint (TODO Batch 9.x
  // verification). For now render 0 until that wiring lands; the SummaryStrip
  // is the only consumer.
  const mtdReturn = 0;
  const mtdReturnPercent = 0;

  return (
    <div className="portfolio-home">
      <Header
        marketPeriod={session.marketPeriod}
        sessionStatus={session.session}
        onIbChange={session.refresh}
      />
      <SummaryStrip
        portfolioValue={portfolioValue}
        mtdReturn={mtdReturn}
        mtdReturnPercent={mtdReturnPercent}
      />
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
        />
      )}
    </div>
  );
}
