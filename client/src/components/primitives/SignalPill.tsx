import type { SignalDirection } from '../../hooks/useSignals';

// Compact signal badge: `[<Type> · <quality>% · <motivation> · $low-high]`.
// Colors per direction — SELL red, BUY green, no_signal gray (see CSS
// `.signal-pill-{type}`). Used on TickerDetail and on TickerCards; both
// directions can render side by side.
const MOTIVATION_SHORT: Record<string, string> = {
  take_profit: 'profit',
  derisk: 'derisk',
  avoid_downside: 'downside',
  pullback_entry: 'pullback',
  breakout_continuation: 'breakout',
  value: 'value',
};

export interface SignalPillProps {
  type: SignalDirection;
  quality: number;
  motivation?: string | null;
  low?: number | null;
  high?: number | null;
}

export function SignalPill({ type, quality, motivation, low, high }: SignalPillProps) {
  if (type === 'no_signal') {
    return <span className="signal-pill signal-pill-no_signal">No signal</span>;
  }
  const label = type === 'sell' ? 'Sell' : 'Buy';
  const mot = motivation ? (MOTIVATION_SHORT[motivation] ?? motivation) : null;
  const range = low != null && high != null ? `$${low}-${high}` : null;
  const parts = [label, `${Math.round(quality)}%`, mot, range].filter(Boolean);
  return <span className={`signal-pill signal-pill-${type}`}>{parts.join(' · ')}</span>;
}
