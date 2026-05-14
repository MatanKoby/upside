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

export type MarketStatKey =
  | 'volume'
  | 'fwdPE'
  | 'priorClose'
  | 'beta'
  | 'range52w'
  | 'open'
  | 'eps'
  | 'marketCap'
  | 'dividend'
  | 'putCall'
  | 'tweetVolume'
  | 'avgVolume';

export type MarketStat = {
  key: MarketStatKey;
  label: string;
  value: string;
  enabled: boolean;
};

export type TickerSignalDetail = {
  type: SignalType;
  confidence: number;
  summary: string;
  rationale: string[];
  styleABreakdown: string;
};

export type PositionStatsDetail = {
  shares: number;
  avgCost: number;
  marketValue: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  dayPnL: number;
  dayPnLPercent: number;
  portfolioWeightPercent: number;
  contributionPercent: number;
  daysHeld: number;
};

export type IndicatorStatus = 'bullish' | 'neutral' | 'bearish' | 'event';

export type IndicatorDetail = {
  name: string;
  value: string;
  status: IndicatorStatus;
  note?: string;
};

// Contract metadata as returned by BE (mirrors server's Contract type).
// Used in TickerDetail to surface industry/category context. Not consumed by
// PositionCard in MVP, but the field is committed so we don't re-migrate later.
export type Contract = {
  conid: number;
  symbol: string;
  companyName: string | null;
  industry: string | null;
  category: string | null;
  assetClass: string;
  currency: string;
  exchange: string | null;
};

// Chart bar shape as it leaves the BE history endpoint.
// Lightweight-charts adapters live in client/src/components/TickerDetail/PriceChart.tsx.
export type ChartBar = {
  t: number;                       // unix milliseconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type VwapPoint = {
  t: number;
  v: number;                       // VWAP value at that bar timestamp
};

export type HistoryBundle = {
  bars: ChartBar[];
  vwap: VwapPoint[];
};

export type TickerDetailData = {
  symbol: string;
  company: string;
  price: number;
  todayChange: number;
  todayChangePercent: number;
  dayLow: number;
  dayHigh: number;
  currentInRange: number;
  marketStats: MarketStat[];
  signal: TickerSignalDetail;
  positionStats: PositionStatsDetail;
  indicators: IndicatorDetail[];
};
