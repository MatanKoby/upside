export type MarketPeriod = 'pre-market' | 'regular' | 'after-hours' | 'closed';
export type SessionStatus = 'connected' | 'disconnected' | 'expired';

export type SignalType = 'sell' | 'no_signal';

export interface Position {
  symbol: string;
  companyName: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  todayChange: number;
  todayChangePct: number;
  vwap: number | null;
  vwapDiffPct: number | null;
  portfolioWeight: number;
  portfolioContribution: number;
  dailyReturn: number | null;
  tradingDaysHeld: number | null;
  updatedAt: string;
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
  symbol: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  volume: number;
  vwap: number | null;
  updatedAt: string;
}

export interface OhlcBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
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
