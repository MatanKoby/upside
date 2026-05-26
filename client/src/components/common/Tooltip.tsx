import { useEffect, useRef, useState, type ReactNode } from 'react';

// Lightweight tooltip used for hover-help affordances (e.g. the profit-taking
// zone icon on PositionCard — Batch 14c).
//
// - Desktop: shows on hover.
// - Mobile: tap toggles it. The trigger stops click propagation + default so a
//   tap on the icon doesn't also fire the surrounding card's navigation.
// - ESC and an outside click dismiss it.
//
// (Spec mentions long-press on mobile; tap-to-toggle is the simpler, more
//  discoverable equivalent and also satisfies "tapping the icon reveals it".)
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDocPointer = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDocPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocPointer);
    };
  }, [open]);

  return (
    <span
      ref={wrapRef}
      className="tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        setOpen((prev) => !prev);
      }}
    >
      {children}
      {open && (
        <span role="tooltip" className="tooltip-bubble">
          {label}
        </span>
      )}
    </span>
  );
}
