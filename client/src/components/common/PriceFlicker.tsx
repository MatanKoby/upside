import { useEffect, useRef, useState } from 'react';

/**
 * Price-change animation per the screener design discussion:
 *
 * - Any price change → brief 200ms color flash on the number + directional
 *   arrow appears for 300ms (▲ green up, ▼ red down).
 * - "Bigger" change → double flash + arrow, 500ms total.
 * - Never hides the price text; the arrow sits absolutely to the right so
 *   layout doesn't shift.
 * - "Bigger" threshold scales with today's realized volatility (uses
 *   `todayChangePct` as a cheap proxy until ATR is available). Floor at
 *   0.5% absolute so micro-wiggles on calm days don't double-flash.
 *
 * Drop-in replacement for any `<span>{formatPrice(price)}</span>` in
 * Watchlist or Screener rows. See `scripts/anim-integration.md` for the
 * single-line swap in pages/Watchlist.tsx.
 */
export function PriceFlicker({
  price,
  todayChangePct,
  format,
  className,
}: {
  price: number | null;
  todayChangePct: number | null;
  format: (v: number) => string;
  className?: string;
}) {
  const previousRef = useRef<number | null>(price);
  const [flash, setFlash] = useState<{ dir: 'up' | 'down'; big: boolean } | null>(null);
  const clearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = previousRef.current;
    if (price == null || prev == null) {
      previousRef.current = price;
      return;
    }
    const delta = price - prev;
    if (delta === 0) return;

    // Big-change threshold: 40% of today's realized abs change, floored at 0.5%.
    // Both are absolute moves in dollars on the current price.
    const todayMagPct = Math.abs(todayChangePct ?? 0);
    const bigThresholdPct = Math.max(0.5, 0.4 * todayMagPct);
    const deltaPct = (Math.abs(delta) / prev) * 100;
    const big = deltaPct >= bigThresholdPct;

    setFlash({ dir: delta > 0 ? 'up' : 'down', big });
    previousRef.current = price;

    if (clearRef.current) clearTimeout(clearRef.current);
    clearRef.current = setTimeout(() => setFlash(null), big ? 500 : 200);

    return () => {
      if (clearRef.current) clearTimeout(clearRef.current);
    };
  }, [price, todayChangePct]);

  // Re-mount the flash element on each event so CSS @keyframes restarts.
  const flashKey = flash ? `${flash.dir}-${flash.big}-${Date.now()}` : 'idle';
  const flashClass = flash
    ? `price-flicker-${flash.dir}${flash.big ? ' price-flicker-big' : ''}`
    : '';

  return (
    <span className={`price-flicker ${className ?? ''}`} key={flashKey}>
      <span className={`price-flicker-text ${flashClass}`}>
        {price != null ? format(price) : '—'}
      </span>
      {flash && (
        <span
          className={`price-flicker-arrow price-flicker-arrow-${flash.dir}${flash.big ? ' price-flicker-arrow-big' : ''}`}
          aria-hidden
        >
          {flash.dir === 'up' ? '▲' : '▼'}
        </span>
      )}
    </span>
  );
}
