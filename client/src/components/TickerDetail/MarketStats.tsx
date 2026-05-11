import { useMemo, useState } from 'react';
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

  const visibleStats = useMemo(() => stats.filter((item) => item.enabled).slice(0, 6), [stats]);

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
