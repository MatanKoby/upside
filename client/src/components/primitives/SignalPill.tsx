import type { SignalDirection } from '../../hooks/useSignals';

// Compact signal badge: `[<Type> · <quality>% · <motivation> · $<price>]`.
// The price is the immediate action (leg[0] of the playbook). Colors per
// direction — SELL red, BUY green, no_signal gray (see CSS `.signal-pill-{type}`).
// Analyses are single-direction now, so a card shows one pill.
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
  // The immediate action's price (leg[0]). Falls back to the optimal/range
  // midpoint when only a range is known.
  price?: number | null;
}

export function SignalPill({ type, quality, motivation, price }: SignalPillProps) {
  if (type === 'no_signal') {
    return <span className="signal-pill signal-pill-no_signal">No signal</span>;
  }
  const label = type === 'sell' ? 'Sell' : 'Buy';
  const mot = motivation ? (MOTIVATION_SHORT[motivation] ?? motivation) : null;
  const priceStr = price != null ? `$${price}` : null;
  const parts = [label, `${Math.round(quality)}%`, mot, priceStr].filter(Boolean);
  return <span className={`signal-pill signal-pill-${type}`}>{parts.join(' · ')}</span>;
}
