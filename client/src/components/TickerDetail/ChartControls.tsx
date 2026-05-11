export type ChartMode = 'line' | 'candle';
export type OverlayKey = 'vwap' | 'volume' | 'rsi';

const OVERLAYS: { key: OverlayKey; label: string }[] = [
  { key: 'vwap', label: 'VWAP' },
  { key: 'volume', label: 'Vol' },
  { key: 'rsi', label: 'RSI' },
];

export function ChartControls({
  mode,
  overlays,
  onModeChange,
  onOverlayToggle,
}: {
  mode: ChartMode;
  overlays: Record<OverlayKey, boolean>;
  onModeChange: (mode: ChartMode) => void;
  onOverlayToggle: (overlay: OverlayKey) => void;
}) {
  return (
    <div className="td-chart-controls">
      <div className="td-control-group">
        {(['line', 'candle'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={mode === item ? 'td-control-pill is-active' : 'td-control-pill'}
            onClick={() => onModeChange(item)}
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
            onClick={() => onOverlayToggle(overlay.key)}
          >
            {overlay.label}
          </button>
        ))}
      </div>
    </div>
  );
}
