// Quick in-app glossary for the technical-analysis terms the entry-zone
// engine uses in its reasoning strings + chip tooltips. Reachable from the
// help icon (?) in the Watchlist header.

interface Term {
  term: string;
  short: string;     // one-liner
  detail?: string;   // optional follow-up
}

const TERMS: Term[] = [
  { term: 'ATR (Average True Range)', short: 'A measure of recent volatility — how far a stock typically moves in one day. ATR(14) = average over the last 14 bars.',
    detail: 'The entry engine uses ATR to decide how reachable a level is. Intraday entries are within ~1×ATR of current price, overnight ~2×ATR, multiday ~4×ATR.' },
  { term: 'RSI (Relative Strength Index)', short: 'Momentum oscillator, 0–100. >70 commonly read as "overbought", <30 as "oversold".',
    detail: 'If RSI > 70 the engine flags the ticker as overbought and widens the entry-reach band by 1.5× so suggested entries sit closer to current price.' },
  { term: 'SMA20 / SMA50 / SMA200', short: 'Simple Moving Average over 20, 50, or 200 daily closes. Smooths out noise; commonly acts as dynamic support/resistance.',
    detail: 'The engine treats SMAs as candidate entry levels. Trend regime in v1 is set by classic alignment: price > SMA20 > SMA50 ⇒ up; the reverse ⇒ down.' },
  { term: 'Pivots (P, S1, S2, R1, R2)', short: 'Floor-trader levels computed from the prior session\'s high/low/close. S1/S2 = support below price; R1/R2 = resistance above.',
    detail: 'Recompute every day. The engine uses S1 and S2 as common short-horizon entry candidates.' },
  { term: 'Bollinger Bands', short: 'A 20-period moving average with ±2 standard-deviation bands. The lower band is a mean-reversion entry candidate.',
    detail: 'Price touching the lower band is a "stretched" signal — often used for dip entries when trend is intact.' },
  { term: 'VWAP (Volume-Weighted Average Price)', short: 'Intraday average price weighted by volume. Resets each session.',
    detail: 'Day traders often use VWAP as the "fair price" benchmark. A pullback to VWAP is a common entry level inside a session.' },
  { term: 'Swing low (recent / major)', short: 'A local bottom — a bar lower than the few bars on each side. "Recent" = most recent; "major" = the lowest one in the trailing window.',
    detail: 'A higher-low off the major swing low is a constructive basing signal.' },
  { term: 'Confluence', short: 'Multiple support levels clustered at the same price (within ~0.5×ATR).',
    detail: 'Confluence usually = stronger level. The engine prefers a candidate with confluence over a lone level even if a closer single level exists.' },
  { term: 'Entry horizons (Today / Days / Weeks)', short: 'How long you\'d wait for the entry to fill.',
    detail: 'Today (Intraday) ≈ same session, within ~1×ATR. Days (Overnight) ≈ 1–2 days, ~2×ATR. Weeks (Multiday) ≈ 1–2 weeks, ~4×ATR.' },
  { term: 'Overbought-tightened', short: 'A flag set when RSI > 70 OR price > SMA50 + 2×ATR.',
    detail: 'When set, the engine pulls entries TOWARD current price (1.5× wider reach), so you get a usable entry suggestion rather than a "wait for a deep pullback that may never come."' },
  { term: 'Marker', short: 'A user-defined price target on a watchlist ticker.',
    detail: 'You set markers yourself (long-press a row). When price crosses, you get a Discord ping. Markers persist across re-imports and aren\'t affected by the engine.' },
];

export function Glossary({ onClose }: { onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet glossary" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>Glossary</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <section className="sheet-section">
          {TERMS.map((t) => (
            <div key={t.term} className="glossary-entry">
              <h3>{t.term}</h3>
              <p className="glossary-short">{t.short}</p>
              {t.detail && <p className="glossary-detail">{t.detail}</p>}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
