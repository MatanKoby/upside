import type { SortKey } from '../../types';

const OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'signals', label: 'Signals' },
  { value: 'pnl', label: 'P&L' },
  { value: 'custom', label: 'Custom' },
];

export function SortBar({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  return (
    <div className="sort-bar" role="tablist">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          className={`sort-pill${value === opt.value ? ' sort-pill-active' : ''}`}
          onClick={() => onChange(opt.value)}
          type="button"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
