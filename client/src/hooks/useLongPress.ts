import { useRef } from 'react';

// useLongPress (Batch X13) — attach a long-press (touch) / right-click (desktop)
// action to an element *nested inside* a clickable row, without colliding with
// the row's own handlers. Used for the ticker-symbol → Robinhood gesture on
// TickerCard surfaces (the row already owns long-press = add-marker and
// tap = open detail).
//
// Behaviour:
// - Stops the press gesture (pointerdown/up) from reaching the parent, so the
//   row's own long-press timer never starts.
// - Suppresses the trailing click *only when the long-press actually fired*, so
//   a plain tap on the symbol still bubbles to the row (tap → detail).
export function useLongPress(action: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation(); // keep the row's long-press from starting
      fired.current = false;
      timer.current = setTimeout(() => {
        fired.current = true;
        action();
      }, ms);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      clear();
    },
    onPointerLeave: () => clear(),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    },
    onClick: (e: React.MouseEvent) => {
      if (fired.current) {
        // The long-press already fired — swallow the click so the row doesn't
        // also navigate / open the marker sheet.
        e.stopPropagation();
        e.preventDefault();
        fired.current = false;
      }
      // otherwise let it bubble to the row (tap → detail)
    },
  };
}
