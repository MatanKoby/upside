import { useMemo } from 'react';
import { PositionCard } from './PositionCard';
import type { ActiveSignal } from '../../hooks/useSignals';
import type { Position, SortKey } from '../../types';

export function PositionList({
  positions,
  sort,
  totalPortfolioValue,
  signalsBySymbol,
}: {
  positions: Position[];
  sort: SortKey;
  totalPortfolioValue: number;
  signalsBySymbol: Record<string, ActiveSignal[]>;
}) {
  const sorted = useMemo(() => {
    const copy = [...positions];
    // Best actionable signal quality for a symbol (-1 when none) drives the
    // "signals" sort.
    const maxQuality = (sym: string): number => {
      const arr = (signalsBySymbol[sym] ?? []).filter((s) => s.type !== 'no_signal');
      return arr.length ? Math.max(...arr.map((s) => s.quality)) : -1;
    };
    if (sort === 'pnl') {
      copy.sort((a, b) => b.unrealizedPnL - a.unrealizedPnL);
    } else if (sort === 'signals') {
      copy.sort((a, b) => {
        const aw = maxQuality(a.symbol);
        const bw = maxQuality(b.symbol);
        if (aw !== bw) return bw - aw;
        return b.unrealizedPnL - a.unrealizedPnL;
      });
    }
    return copy;
  }, [positions, sort, signalsBySymbol]);

  return (
    <div className="position-list">
      {sorted.map((p) => (
        <PositionCard
          key={p.symbol}
          position={p}
          totalPortfolioValue={totalPortfolioValue}
          signals={signalsBySymbol[p.symbol]}
        />
      ))}
    </div>
  );
}
