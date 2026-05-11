import { useState, useRef, useEffect } from 'react';
import type { MarketPeriod } from '../../types';

const PERIOD_LABEL: Record<MarketPeriod, string> = {
  'pre-market': 'Pre-market',
  'regular': 'Regular',
  'after-hours': 'After-hours',
  'closed': 'Closed',
};

export function MarketPeriodBadge({ period }: { period: MarketPeriod }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="period-badge" ref={ref}>
      <button
        className="period-badge-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        type="button"
      >
        <span className={`period-dot period-dot-${period}`} aria-hidden="true" />
        <span>{PERIOD_LABEL[period]}</span>
      </button>
      {open && (
        <div className="period-popover" role="dialog" aria-label="Market hours">
          <div className="period-popover-title">NYSE / NASDAQ</div>
          <div className="period-popover-row">Pre-market <span>4:00–9:30 AM ET</span></div>
          <div className="period-popover-row">Regular <span>9:30 AM–4:00 PM ET</span></div>
          <div className="period-popover-row">After-hours <span>4:00–8:00 PM ET</span></div>
        </div>
      )}
    </div>
  );
}
