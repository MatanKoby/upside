// IntradayStatsChip — single-glance "where today sits in the historical
// intraday-low band" indicator for the watchlist row.
//
// Math: dropPct = (open - price) / open * 100. p50 = typical intraday-low dip
// from open, p75 = the deeper-than-typical dip. Three states:
//   above     dropPct < p50 (or price > open)  — neutral, no urgency
//   typical   p50 ≤ dropPct < p75               — accent (we're at typical low)
//   deep      dropPct ≥ p75                     — gain (deeper than typical)
//
// Hidden entirely when we have no stats row or no today_open — surfacing "—"
// here would just add noise to the row.

import type { IntradayStatsRow } from '../../hooks/useWatchlistData';

interface Props {
  stats: IntradayStatsRow | undefined;
  price: number | null;
  todayOpen: number | null;
}

export function IntradayStatsChip({ stats, price, todayOpen }: Props) {
  if (!stats || price == null || todayOpen == null || todayOpen <= 0) return null;
  const p50 = stats.intraday_low_pct_p50;
  const p75 = stats.intraday_low_pct_p75;
  if (p50 == null || p75 == null) return null;

  const dropPct = ((todayOpen - price) / todayOpen) * 100;
  let state: 'above' | 'typical' | 'deep';
  if (dropPct >= p75) state = 'deep';
  else if (dropPct >= p50) state = 'typical';
  else state = 'above';

  const title =
    `Today: ${dropPct.toFixed(1)}% below open ($${todayOpen.toFixed(2)})\n` +
    `Typical intraday-low: -${p50.toFixed(1)}% · deep: -${p75.toFixed(1)}%\n` +
    `(${stats.lookback_days}d lookback, n=${stats.sample_size})`;

  return (
    <span className={`stats-chip stats-chip-${state}`} title={title}>
      <span className="stats-chip-icon">▼</span>
      <span className="stats-chip-val">{dropPct.toFixed(1)}%</span>
      <span className="stats-chip-sep">/</span>
      <span className="stats-chip-band">{p50.toFixed(1)}–{p75.toFixed(1)}</span>
    </span>
  );
}
