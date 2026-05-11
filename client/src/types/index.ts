export type SignalType = 'sell' | 'buy' | 'event' | 'watch';

export type Signal = {
  type: SignalType;
  confidence: number;
  summary: string;
  daysAway?: number;
};

export type Position = {
  symbol: string;
  name: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  todayChange: number;
  todayChangePercent: number;
  vwap: number;
  sparkline: number[];
  signal?: Signal;
};

export type MarketPeriod = 'pre-market' | 'regular' | 'after-hours' | 'closed';

export type SortKey = 'signals' | 'pnl' | 'custom';

export type AccountSummary = {
  portfolioValue: number;
  mtdReturn: number;
  mtdReturnPercent: number;
  marketPeriod: MarketPeriod;
};
