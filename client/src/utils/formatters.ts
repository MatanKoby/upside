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
