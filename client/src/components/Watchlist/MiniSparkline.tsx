// Tiny inline SVG sparkline for watchlist rows. Takes an array of closes
// (typically 7 daily); auto-scales y; colors up/down via the last vs first.

interface Props {
  closes: number[];
  width?: number;
  height?: number;
}

export function MiniSparkline({ closes, width = 44, height = 14 }: Props) {
  if (!closes || closes.length < 2) return null;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const step = closes.length > 1 ? width / (closes.length - 1) : width;
  const pts = closes.map((c, i) => {
    const x = i * step;
    const y = height - ((c - min) / span) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const up = closes[closes.length - 1]! >= closes[0]!;
  const stroke = up ? 'rgb(99,153,34)' : 'rgb(226,75,74)';
  return (
    <svg width={width} height={height} className="mini-sparkline" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={stroke} strokeWidth={1} />
    </svg>
  );
}
