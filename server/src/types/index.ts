export type MarketPeriod = 'pre-market' | 'regular' | 'after-hours' | 'closed';
export type SessionStatus = 'connected' | 'disconnected' | 'expired';

export type SignalType = 'sell' | 'no_signal';

export interface Position {
  // IB identity
  conid: number;
  accountId: string;
  symbol: string;
  companyName: string | null;     // null until contracts cache populated
  // Position math
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number | null;
  todayChange: number;
  todayChangePct: number;
  // Live indicators
  vwap: number | null;
  vwapUpdatedAt: string | null;
  // Portfolio context (computed)
  portfolioWeight: number;
  portfolioContribution: number;
  dailyReturn: number | null;
  tradingDaysHeld: number | null;
  // Contract metadata (from contracts cache)
  currency: string;
  assetClass: string;             // "STK" for MVP
  industry: string | null;
  category: string | null;
  updatedAt: string;
}

// Per-conid metadata cache row.
export interface Contract {
  conid: number;
  symbol: string;
  companyName: string | null;
  industry: string | null;
  category: string | null;
  assetClass: string;
  currency: string;
  exchange: string | null;
  validExchanges: string | null;
  refreshedAt: string;
}

export interface PortfolioSummary {
  totalValue: number;
  mtdReturn: number;
  mtdReturnPct: number;
  updatedAt: string;
}

export interface IndicatorSnapshot {
  name: string;
  value: string;
  status: 'bullish' | 'bearish' | 'neutral';
}

export interface IndicatorBullet {
  indicator: string;
  rationale: string;
}

export interface Signal {
  id: string;
  symbol: string;
  conid: number | null;           // stored at analysis time; null on legacy rows
  userId: string;
  signalType: SignalType;
  signalQuality: number;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  optimalPrice: number | null;
  reasoning: string;
  indicatorBullets: IndicatorBullet[];
  indicatorSnapshot: IndicatorSnapshot[];
  actualMaxSinceAnalysis: number | null;
  actualMinSinceAnalysis: number | null;
  enteredRangeAt: string | null;
  exitedRangeAt: string | null;
  supersededByAnalysisId: string | null;
  analyzedAt: string;
  expiresAt: string | null;
}

export interface MarketSnapshot {
  conid: number;
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  bid: number;
  ask: number;
  volume: number;
  vwap: number | null;            // computed from intraday history, not IB
  updatedAt: string;
}

// Normalized chart bar (IB raw uses {t, o, h, l, c, v} with t in milliseconds;
// we keep that shape since lightweight-charts handles both sec and ms timestamps).
export interface OhlcBar {
  t: number;                      // unix milliseconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// Computed per-bar VWAP returned alongside chart bars.
export interface VwapPoint {
  t: number;                      // matches the bar timestamp
  v: number;                      // VWAP value
}

// Bundle returned by /api/marketdata/history/:symbol so FE gets both at once.
export interface HistoryBundle {
  bars: OhlcBar[];
  vwap: VwapPoint[];
}

// ============================================================================
// Raw IB response shapes (boundary types — used by ibMappers, not surfaced to FE).
// ============================================================================

export interface RawIbPosition {
  acctId: string;
  conid: number;
  contractDesc: string;
  position: number;               // shares
  mktPrice: number;
  mktValue: number;
  currency: string;
  avgCost: number;
  avgPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  assetClass: string;
  undConid: number | null;
  // options-specific (always null/0 for stocks; ignored in mapping)
  exchs?: string | null;
  expiry?: string | null;
  putOrCall?: string | null;
  multiplier?: number | null;
  strike?: number;
  exerciseStyle?: string | null;
  conExchMap?: unknown[];
  model?: string;
}

export interface RawIbContractInfo {
  con_id: number;
  symbol: string;
  company_name: string | null;
  industry: string | null;
  category: string | null;
  instrument_type: string;
  currency: string;
  exchange: string | null;
  valid_exchanges: string | null;
  local_symbol: string | null;
  underlying_con_id: number | null;
  has_related_contracts: boolean;
  // additional fields IB returns but we don't use
  [key: string]: unknown;
}

export interface RawIbSnapshot {
  conid: number;
  conidEx: string;
  // Field codes appear as string keys when populated. Empty when subscription
  // hasn't warmed yet (subscribe-then-poll pattern).
  // 31 = last, 70 = high, 71 = low, 82 = change%, 83 = changeUsd,
  // 84 = bid, 86 = ask, 87 = volume, 7295 = open, 7296 = prevClose.
  '31'?: string | number;
  '70'?: string | number;
  '71'?: string | number;
  '82'?: string | number;
  '83'?: string | number;
  '84'?: string | number;
  '86'?: string | number;
  '87'?: string | number;
  '7295'?: string | number;
  '7296'?: string | number;
  [field: string]: unknown;
}

export interface RawIbHistoryBar {
  t: number;                      // unix ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface RawIbHistory {
  serverId: string;
  symbol: string;
  text: string;
  priceFactor: number;
  startTime: string;
  timePeriod: string;
  barLength: number;
  mdAvailability: string;
  mktDataDelay: number;
  outsideRth: boolean;
  data: RawIbHistoryBar[];
  [key: string]: unknown;
}

export interface RawIbSecdefResult {
  conid: string;                  // IB returns it as string in secdef/search
  symbol: string;
  companyName: string;
  companyHeader: string;
  description: string;            // exchange shortcode, e.g. "NYSE"
  restricted?: string;
  sections: Array<{
    secType: string;
    months?: string;
    exchange?: string;
    conid?: string;
  }>;
}

export interface UserPreferences {
  userId: string;
  signalThreshold: number;
  signalMinMarketValue: number;
  suppressedSymbols: string[];
  sortOrder: 'signals' | 'pnl' | 'custom';
  statConfig: string[];
  theme: 'dark' | 'light';
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  llmProvider: 'gemini' | 'claude' | 'openai';
}

export interface AnalysisLock {
  id: string;
  symbol: string;
  userId: string;
  startedAt: string;
  status: 'running' | 'failed';
}

export interface AccessAttempt {
  id: string;
  email: string;
  granted: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  attemptedAt: string;
}

export interface AuthedUser {
  id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}
