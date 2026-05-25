import { useEffect, useMemo, useState } from 'react';
import { IconAdjustments, IconGripVertical, IconArrowNarrowUp, IconArrowNarrowDown } from '@tabler/icons-react';
import { formatCurrency } from '../../utils/formatters';
import type { MarketStat, TickerDetailData } from '../../types';

function moveStat(stats: MarketStat[], from: number, to: number): MarketStat[] {
  if (to < 0 || to >= stats.length) {
    return stats;
  }
  const copy = [...stats];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

type Week52 = NonNullable<TickerDetailData['week52']>;

export function MarketStats({
  initialStats,
  week52,
}: {
  initialStats: MarketStat[];
  week52?: Week52 | null;
}) {
  const [stats, setStats] = useState(initialStats);
  const [editOpen, setEditOpen] = useState(false);

  // The snapshot resolves after mount, so `initialStats` arrives populated a
  // beat later — re-seed local state when it changes. (Reorder/visibility
  // persistence to user_preferences.stat_config lands in Batch 15.)
  useEffect(() => {
    setStats(initialStats);
  }, [initialStats]);

  const visibleStats = useMemo(() => stats.filter((item) => item.enabled).slice(0, 6), [stats]);
  const dotOffset = week52
    ? `${Math.max(0, Math.min(100, week52.currentRatio * 100))}%`
    : '0%';

  return (
    <section className="td-market-stats">
      <div className="td-market-stats-head">
        <h3>Market stats</h3>
        <button type="button" className="td-inline-btn" onClick={() => setEditOpen((prev) => !prev)}>
          <IconAdjustments size={14} />
          <span>Edit</span>
        </button>
      </div>

      <div className="td-market-grid">
        {visibleStats.map((stat) => (
          <div key={stat.key} className="td-market-cell">
            <span className="td-market-label">{stat.label}</span>
            <span className="td-market-value">{stat.value}</span>
          </div>
        ))}
      </div>

      {week52 && (
        <div className="td-range td-range--52w">
          <div className="td-range-head">
            <span className="td-range-low">{formatCurrency(week52.low)}</span>
            <span className="td-range-label">52-week range</span>
            <span className="td-range-high">{formatCurrency(week52.high)}</span>
          </div>
          <div className="td-range-bar-wrap">
            <div className="td-range-bar" />
            <span className="td-range-current-dot" style={{ left: dotOffset }} />
          </div>
        </div>
      )}

      {editOpen && (
        <div className="td-market-edit">
          {stats.map((stat, index) => (
            <div key={stat.key} className="td-market-edit-row">
              <IconGripVertical size={14} className="td-market-handle" />
              <label className="td-market-toggle">
                <input
                  type="checkbox"
                  checked={stat.enabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setStats((prev) => prev.map((item) => (
                      item.key === stat.key ? { ...item, enabled: checked } : item
                    )));
                  }}
                />
                <span>{stat.label}</span>
              </label>
              <div className="td-market-edit-actions">
                <button type="button" onClick={() => setStats((prev) => moveStat(prev, index, index - 1))}>
                  <IconArrowNarrowUp size={14} />
                </button>
                <button type="button" onClick={() => setStats((prev) => moveStat(prev, index, index + 1))}>
                  <IconArrowNarrowDown size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
