export type SignalType = 'sell' | 'buy' | 'event' | 'watch';

export type Signal = {
  type: SignalType;
  confidence: number;
  summary: string;
  daysAway?: number;
};

export type Position = {
  // IBKR conid — the join key for instrument-scoped tables (risk_flags,
  // band_state, …). Nullable until the position's contract resolves.
  conid: number | null;
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
  // Profit-taking zone (Batch 14c). `zoneEnteredAt` non-null ⇒ currently in
  // zone; `enteredZoneViaGap` flags an entry outside regular hours (GAP badge).
  zoneEnteredAt?: string | null;
  enteredZoneViaGap?: boolean;
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
  | 'avgVolume'
  // Volatility metrics (added 2026-05-30) — see buildMarketStats in
  // hooks/useTickerDetail.ts. Headlines the scalping-decision view.
  | 'atr'
  | 'rangeToday'
  | 'scalpableSessions';

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
  // Provenance of the entry date the above two derive from. 'ib_transactions'
  // = exact (deduced from IB's transaction history); 'observed' = floor
  // (Upside's first sight, real entry may be earlier). FE renders "N days" vs
  // "≥N days" accordingly.
  daysHeldSource: 'observed' | 'ib_transactions';
  // unrealizedPnLPercent / tradingDaysHeld. Null when entry date unknown or
  // first poll hasn't completed.
  dailyReturnPercent: number | null;
  // ISO entry timestamp (positions.first_seen_at). Drives the chart's entry
  // marker, which only renders when this falls in the visible window.
  entryDate: string | null;
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
  // IBKR conid — joins instrument-scoped tables (risk_flags). Null when the
  // ticker has no resolved contract yet.
  conid: number | null;
  symbol: string;
  company: string;
  price: number;
  todayChange: number;
  todayChangePercent: number;
  dayLow: number;
  dayHigh: number;
  currentInRange: number;
  marketStats: MarketStat[];
  // Signal absent for positions that have never been analyzed. Populated by
  // Batch 14a's signal engine once that lands.
  signal: TickerSignalDetail | null;
  // Position stats are held-only. Non-held tickers (post-MVP browsing case)
  // render the same screen with this section omitted.
  positionStats: PositionStatsDetail | null;
  indicators: IndicatorDetail[];
};
