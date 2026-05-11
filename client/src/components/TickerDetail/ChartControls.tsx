import { useState } from 'react';

type ChartMode = 'line' | 'candle';
type OverlayKey = 'vwap' | 'volume' | 'rsi';

const OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: 'vwap', label: 'VWAP' },
  { key: 'volume', label: 'Vol' },
  { key: 'rsi', label: 'RSI' },
];

export function ChartControls() {
  const [mode, setMode] = useState<ChartMode>('line');
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({
    vwap: true,
    volume: true,
    rsi: false,
  });

  return (
    <div className="td-chart-controls">
      <div className="td-control-group">
        {(['line', 'candle'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? 'td-control-pill is-active' : 'td-control-pill'}
            onClick={() => setMode(item)}
          >
            {item === 'line' ? 'Line' : 'Candle'}
          </button>
        ))}
      </div>

      <div className="td-control-group">
        {OVERLAYS.map((overlay) => (
          <button
            key={overlay.key}
            type="button"
            className={overlays[overlay.key] ? 'td-control-pill is-active' : 'td-control-pill'}
            onClick={() => {
              setOverlays((prev) => ({ ...prev, [overlay.key]: !prev[overlay.key] }));
            }}
          >
            {overlay.label}
          </button>
        ))}
      </div>
    </div>
  );
}
