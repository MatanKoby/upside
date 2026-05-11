import { useState } from 'react';
import { Header } from '../components/PortfolioHome/Header';
import { SummaryStrip } from '../components/PortfolioHome/SummaryStrip';
import { SortBar } from '../components/PortfolioHome/SortBar';
import { PositionList } from '../components/PortfolioHome/PositionList';
import { mockAccount, mockPositions } from '../data/mockPositions';
import type { SortKey } from '../types';

export default function PortfolioHome() {
  const [sort, setSort] = useState<SortKey>('signals');
  return (
    <div className="portfolio-home">
      <Header marketPeriod={mockAccount.marketPeriod} />
      <SummaryStrip
        portfolioValue={mockAccount.portfolioValue}
        mtdReturn={mockAccount.mtdReturn}
        mtdReturnPercent={mockAccount.mtdReturnPercent}
      />
      <SortBar value={sort} onChange={setSort} />
      <PositionList
        positions={mockPositions}
        sort={sort}
        totalPortfolioValue={mockAccount.portfolioValue}
      />
    </div>
  );
}
