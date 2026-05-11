import type { Tone } from '../../utils/calculations';

function deriveTone(data: number[]): Tone {
  if (data.length < 2) return 'neutral';
  const first = data[0];
  const last = data[data.length - 1];
  const change = ((last - first) / first) * 100;
  if (change > 1) return 'gain';
  if (change < -1) return 'loss';
  return 'neutral';
}

export function Sparkline({ data, width = 44, height = 20 }: {
  data: number[];
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const tone = deriveTone(data);
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke={`rgb(var(--${tone}-rgb))`}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
