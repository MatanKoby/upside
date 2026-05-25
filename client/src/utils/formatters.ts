const CURRENCY_2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const CURRENCY_0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(amount: number, decimals = true): string {
  return decimals ? CURRENCY_2.format(amount) : CURRENCY_0.format(amount);
}

export function formatSignedCurrency(amount: number, decimals = true): string {
  const sign = amount >= 0 ? '+' : '-';
  return sign + formatCurrency(Math.abs(amount), decimals);
}

export function formatSignedPercent(percent: number, decimals = 1): string {
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(decimals)}%`;
}

export function formatPnL(dollars: number, percent: number): string {
  return `${formatSignedCurrency(dollars, false)} (${formatSignedPercent(percent)})`;
}

// Abbreviated magnitude for large counts (volume, avg vol): 43_100_000 → "43.1M".
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

// Abbreviated dollar magnitude (market cap): 3_450_000_000_000 → "$3.45T".
export function formatCompactCurrency(n: number): string {
  return `$${formatCompact(n)}`;
}
