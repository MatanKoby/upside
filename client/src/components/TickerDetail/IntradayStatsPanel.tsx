// IntradayStatsPanel — the three Batch B stats laid out for TickerDetail.
//
// Each row: stat name + mean + (p50 / extreme percentile). For the fades we
// show p25 as the "soft / typical fade" anchor; for intraday_low we show p75
// as the "deeper than typical" anchor. All percentages stay percentages — we
// don't try to convert to price here; the row already shows current/open.
//
// Empty-state copy is explicit: stats only exist for conids the nightly cron
// has covered. We show what we know rather than rendering em-dashes for
// missing percentiles.

import type { IntradayStatsRow } from '../../hooks/useWatchlistData';

interface Props {
  stats: IntradayStatsRow | null;
}

function pct(n: number | null): string {
  if (n == null) return '—';
  return `${n.toFixed(2)}%`;
}

export function IntradayStatsPanel({ stats }: Props) {
  if (!stats) {
    return (
      <p className="td-empty-note">
        No intraday stats yet — they're computed nightly from the last
        ~60 trading days of 5-min bars. New tickers populate after the
        first cron run.
      </p>
    );
  }

  const rows: Array<{
    label: string;
    desc: string;
    mean: number | null;
    p50: number | null;
    extreme: number | null;
    extremeLabel: string;
  }> = [
    {
      label: 'Open fade',
      desc: 'first ~30 min after open',
      mean: stats.open_fade_pct_mean,
      p50: stats.open_fade_pct_p50,
      extreme: stats.open_fade_pct_p25,
      extremeLabel: 'soft',
    },
    {
      label: 'Close fade',
      desc: 'last ~30 min into close',
      mean: stats.close_fade_pct_mean,
      p50: stats.close_fade_pct_p50,
      extreme: stats.close_fade_pct_p25,
      extremeLabel: 'soft',
    },
    {
      label: 'Intraday low',
      desc: '% drop from open to day-low',
      mean: stats.intraday_low_pct_mean,
      p50: stats.intraday_low_pct_p50,
      extreme: stats.intraday_low_pct_p75,
      extremeLabel: 'deep',
    },
  ];

  return (
    <div className="td-stats-panel">
      <table className="td-stats-table">
        <thead>
          <tr>
            <th>Stat</th>
            <th>Mean</th>
            <th>Typical (p50)</th>
            <th>Extreme</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>
                <div className="td-stats-label">{r.label}</div>
                <div className="td-stats-desc">{r.desc}</div>
              </td>
              <td>{pct(r.mean)}</td>
              <td>{pct(r.p50)}</td>
              <td>
                {pct(r.extreme)}
                <span className="td-stats-extreme-tag"> ({r.extremeLabel})</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="td-stats-foot">
        {stats.lookback_days}-day lookback · n={stats.sample_size} sessions ·
        computed {new Date(stats.computed_at).toLocaleString()}
      </p>
    </div>
  );
}
