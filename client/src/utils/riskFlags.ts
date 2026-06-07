// Risk-flag presentation helpers (Batch R2) — pure functions over the
// `risk_flags` row shape that R1's engine writes. Keep all the plain-language
// copy + the badge dominant-flag logic here so the components stay dumb. See
// spec/signals/risk-flags.md + spec/screens/portfolio.md → Danger badge.

import { formatCompact, formatCompactCurrency } from './formatters';

export type RiskFlagKey =
  | 'price_surge'
  | 'volume_spike'
  | 'rsi_overbought'
  | 'near_52w_high_surge'
  | 'micro_cap'
  | 'earnings_imminent'
  | 'bad_news';

export type RiskSeverity = 'warning' | 'critical';

// One active flag (mirrors server's ActiveFlag — flags jsonb element).
export interface ActiveFlag {
  key: RiskFlagKey;
  since: string; // YYYY-MM-DD — first day the condition held
  payload: Record<string, number | null>;
}

export interface RiskFlagRow {
  conid: number;
  asofDate: string;
  severity: RiskSeverity;
  flags: ActiveFlag[];
}

// Priority order for picking the badge's dominant flag (most alarming /
// informative first). price_surge is the pump spine, so it leads.
const PRIORITY: RiskFlagKey[] = [
  'price_surge',
  'micro_cap',
  'earnings_imminent',
  'bad_news',
  'near_52w_high_surge',
  'rsi_overbought',
  'volume_spike',
];

// Full-name title for the Risk-flags section rows.
const FLAG_NAME: Record<RiskFlagKey, string> = {
  price_surge: 'Price surge',
  volume_spike: 'Volume spike',
  rsi_overbought: 'RSI overbought',
  near_52w_high_surge: 'Near 52-week high',
  micro_cap: 'Micro-cap',
  earnings_imminent: 'Earnings imminent',
  bad_news: 'Negative news',
};

function n(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Short label for the danger pill on a card. earnings is dynamic so the user
// sees the days at a glance ("Earnings 3d").
export function flagBadgeLabel(flag: ActiveFlag): string {
  switch (flag.key) {
    case 'price_surge':
      return 'Pump';
    case 'volume_spike':
      return 'Volume';
    case 'rsi_overbought':
      return 'Overbought';
    case 'near_52w_high_surge':
      return '52w high';
    case 'micro_cap':
      return 'Micro-cap';
    case 'earnings_imminent': {
      const d = n(flag.payload.days);
      return d == null ? 'Earnings' : `Earnings ${Math.round(d)}d`;
    }
    case 'bad_news':
      return 'Bad news';
  }
}

export function flagName(key: RiskFlagKey): string {
  return FLAG_NAME[key];
}

// Plain-language explanation for a flag row, filled from its payload.
export function flagExplanation(flag: ActiveFlag): string {
  const p = flag.payload;
  switch (flag.key) {
    case 'price_surge': {
      const pct = n(p.surge_pct);
      const w = n(p.window);
      return `Up ${pct ?? '?'}% over ${w ?? '?'} sessions — momentum, no fundamental anchor.`;
    }
    case 'volume_spike': {
      const rv = n(p.rel_volume);
      return `Volume ${rv ?? '?'}× the ~30-day average — abnormal participation.`;
    }
    case 'rsi_overbought': {
      const rsi = n(p.rsi14);
      const t = n(p.threshold);
      return `RSI ${rsi ?? '?'} — overbought (above ${t ?? '?'}).`;
    }
    case 'near_52w_high_surge': {
      const off = n(p.pct_from_52w_high);
      const within = off == null ? '?' : Math.abs(off).toFixed(1);
      return `Surged to within ${within}% of the 52-week high — bought at the peak.`;
    }
    case 'micro_cap': {
      const cap = n(p.market_cap_usd);
      return `Micro-cap${cap == null ? '' : ` (~${formatCompactCurrency(cap)})`} — thin float, extreme moves.`;
    }
    case 'earnings_imminent': {
      const d = n(p.days);
      const days = d == null ? '?' : Math.round(d);
      return `Earnings in ${days} ${days === 1 ? 'day' : 'days'} — binary event + IV-crush risk.`;
    }
    case 'bad_news': {
      const s = n(p.news_score);
      return `Recent headlines skew bearish${s == null ? '' : ` (sentiment ${s.toFixed(2)})`} — negative news flow.`;
    }
  }
}

// The tunable threshold that fired — shown muted next to each section row so it
// reads against the user's Settings values.
export function flagThreshold(flag: ActiveFlag): string {
  const p = flag.payload;
  const t = n(p.threshold);
  switch (flag.key) {
    case 'price_surge':
      return `trailing ${n(p.window) ?? '?'}-session window`;
    case 'volume_spike':
      return t == null ? '' : `≥ ${t}× avg`;
    case 'rsi_overbought':
      return t == null ? '' : `> ${t}`;
    case 'near_52w_high_surge':
      return t == null ? '' : `within ${t}% of high`;
    case 'micro_cap':
      return t == null ? '' : `< ${formatCompact(t)} cap`;
    case 'earnings_imminent':
      return t == null ? '' : `< ${t} days out`;
    case 'bad_news':
      return t == null ? '' : `≤ ${t} sentiment`;
  }
}

// The highest-priority active flag — drives the badge label.
export function dominantFlag(row: RiskFlagRow): ActiveFlag {
  for (const key of PRIORITY) {
    const hit = row.flags.find((f) => f.key === key);
    if (hit) return hit;
  }
  return row.flags[0];
}

// Flags ordered for display (priority order, stable).
export function orderedFlags(row: RiskFlagRow): ActiveFlag[] {
  return [...row.flags].sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));
}

export function isCritical(row: RiskFlagRow | null | undefined): boolean {
  return row?.severity === 'critical';
}
