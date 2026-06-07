// Assembles RiskFlagInputs from raw daily bars + Finnhub fundamentals +
// earnings calendar (Batch R1). Pure helpers — no DB / env — so they're tested
// alongside computeRiskFlags. Used by both riskFlagsCron and signalEngine's
// on-demand top-up.

import { rsi } from '../technicals.js';
import type { FinnhubMetrics } from '../finnhub.js';
import type { RiskFlagConfig } from '../../config/riskFlags.js';
import type { RiskFlagInputs } from './computeRiskFlags.js';

// trailing-N-session return %: (current − close N sessions ago) / close × 100.
// `closes` is the daily close series (oldest first); `current` is the live
// price (or today's last close). Needs N+1 closes.
export function surgePctFromBars(
  closes: number[],
  current: number | null,
  n: number,
): number | null {
  if (current == null || closes.length < n + 1) return null;
  const past = closes[closes.length - 1 - n];
  if (past == null || past <= 0) return null;
  return ((current - past) / past) * 100;
}

// today's volume / trailing-30d average (excluding today). Needs 31 bars.
export function relVolumeFromBars(volumes: number[]): number | null {
  if (volumes.length < 31) return null;
  const today = volumes[volumes.length - 1];
  const prior = volumes.slice(-31, -1);
  const avg = prior.reduce((a, b) => a + (b ?? 0), 0) / prior.length;
  return today != null && avg > 0 ? today / avg : null;
}

// Finnhub `marketCapitalization` is in millions → USD.
export function marketCapUsdFromMetric(metric: FinnhubMetrics | null): number | null {
  if (!metric) return null;
  const m = metric['marketCapitalization'];
  const n = typeof m === 'number' ? m : parseFloat(String(m));
  return Number.isFinite(n) && n > 0 ? n * 1e6 : null;
}

// Days until the next FUTURE earnings date from /calendar/earnings?symbol=
// (shape: { earningsCalendar: [{ date: 'YYYY-MM-DD', ... }] }). Returns the
// smallest non-negative day count, or null when no upcoming date is known.
export function earningsDaysFromCalendar(raw: unknown, today = new Date()): number | null {
  const rows = (raw as { earningsCalendar?: Array<{ date?: string }> } | null)?.earningsCalendar;
  if (!Array.isArray(rows)) return null;
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  let best: number | null = null;
  for (const r of rows) {
    if (!r?.date) continue;
    const ms = new Date(`${r.date}T00:00:00Z`).getTime();
    if (!Number.isFinite(ms)) continue;
    const days = Math.round((ms - todayMs) / 86_400_000);
    if (days >= 0 && (best == null || days < best)) best = days;
  }
  return best;
}

export function buildRiskFlagInputs(opts: {
  closes: number[];
  volumes: number[];
  high52w: number | null;
  currentPrice: number | null;
  metric: FinnhubMetrics | null;
  earningsRaw: unknown;
  config: RiskFlagConfig;
  newsScore?: number | null; // Batch X7 — bad_news input; omit/null → no bad_news flag
}): RiskFlagInputs {
  const { closes, volumes, high52w, currentPrice, metric, earningsRaw, config, newsScore } = opts;
  return {
    currentPrice,
    surgePct: surgePctFromBars(closes, currentPrice, config.surgeWindowSessions),
    rsi14: rsi(closes),
    relVolume: relVolumeFromBars(volumes),
    high52w,
    marketCapUsd: marketCapUsdFromMetric(metric),
    earningsDays: earningsDaysFromCalendar(earningsRaw),
    newsScore: newsScore ?? null,
  };
}
