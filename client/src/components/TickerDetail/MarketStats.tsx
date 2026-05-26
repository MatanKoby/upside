import { useEffect, useMemo, useState } from 'react';
import { IconAdjustments, IconGripVertical, IconArrowNarrowUp, IconArrowNarrowDown } from '@tabler/icons-react';
import type { MarketStat } from '../../types';

function moveStat(stats: MarketStat[], from: number, to: number): MarketStat[] {
  if (to < 0 || to >= stats.length) {
    return stats;
  }
  const copy = [...stats];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

export function MarketStats({ initialStats }: { initialStats: MarketStat[] }) {
  const [stats, setStats] = useState(initialStats);
  const [editOpen, setEditOpen] = useState(false);

  // The snapshot resolves after mount, so `initialStats` arrives populated a
  // beat later — re-seed local state when it changes. (Reorder/visibility
  // persistence to user_preferences.stat_config lands in Batch 15.)
  useEffect(() => {
    setStats(initialStats);
  }, [initialStats]);

  // Render every enabled stat (4-per-row grid handles the wrapping); no fixed
  // cap, so the panel grows to fit rather than truncating.
  const visibleStats = useMemo(() => stats.filter((item) => item.enabled), [stats]);

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
