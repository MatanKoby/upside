export type Tone = 'gain' | 'loss' | 'neutral';

export function getTintOpacity(pnlPercent: number): number {
  const abs = Math.abs(pnlPercent);
  if (abs < 1) return 0.04;
  if (abs < 5) return 0.05;
  if (abs < 10) return 0.07;
  if (abs < 20) return 0.10;
  return 0.14;
}

export function getPnlColor(pnlPercent: number): Tone {
  if (pnlPercent > 1) return 'gain';
  if (pnlPercent < -1) return 'loss';
  return 'neutral';
}

export type VwapState = 'above' | 'below' | 'flat';

export function getVwapDelta(currentPrice: number, vwap: number): {
  diffPercent: number;
  state: VwapState;
} {
  const diffPercent = ((currentPrice - vwap) / vwap) * 100;
  if (diffPercent > 0.1) return { diffPercent, state: 'above' };
  if (diffPercent < -0.1) return { diffPercent, state: 'below' };
  return { diffPercent, state: 'flat' };
}

export function getPositionWeight(marketValue: number, totalPortfolioValue: number): number {
  if (totalPortfolioValue <= 0) return 0;
  return (marketValue / totalPortfolioValue) * 100;
}
