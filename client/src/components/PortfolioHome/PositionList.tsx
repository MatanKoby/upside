import { useMemo } from 'react';
import { PositionCard } from './PositionCard';
import type { Position, SortKey } from '../../types';

export function PositionList({
  positions,
  sort,
  totalPortfolioValue,
}: {
  positions: Position[];
  sort: SortKey;
  totalPortfolioValue: number;
}) {
  const sorted = useMemo(() => {
    const copy = [...positions];
    if (sort === 'pnl') {
      copy.sort((a, b) => b.unrealizedPnL - a.unrealizedPnL);
    } else if (sort === 'signals') {
      copy.sort((a, b) => {
        const aw = a.signal ? a.signal.confidence : -1;
        const bw = b.signal ? b.signal.confidence : -1;
        if (aw !== bw) return bw - aw;
        return b.unrealizedPnL - a.unrealizedPnL;
      });
    }
    return copy;
  }, [positions, sort]);

  return (
    <div className="position-list">
      {sorted.map((p) => (
        <PositionCard key={p.symbol} position={p} totalPortfolioValue={totalPortfolioValue} />
      ))}
    </div>
  );
}
