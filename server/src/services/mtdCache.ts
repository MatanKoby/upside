// Batch 13.5 — Month-to-date portfolio-value cache.
//
// IB's account summary doesn't expose MTD return as a field, so we compute it
// locally from a stable per-month anchor. ibPricePoller calls
// recordPortfolioValueForMtd() on every successful cycle; SET NX makes only
// the first call of each month land. /api/portfolio/summary reads the anchor
// and returns MTD$ and MTD%.
//
// Why Redis: anchor must survive api restarts (Redis volume is persistent),
// and per-month-keyed SET NX gives us natural idempotency without locking.
// 60-day TTL cleans up old months automatically.

import { redis } from './redis.js';

const TTL_SECONDS = 60 * 24 * 60 * 60;

function monthKey(userId: string, date: Date = new Date()): string {
  // UTC-keyed — month rollover is uniform across users. ET-based rollover
  // would match trader intuition more closely but is unnecessary precision
  // for an MTD metric.
  const ym = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `mtd:${userId}:${ym}`;
}

export async function recordPortfolioValueForMtd(
  userId: string,
  portfolioValue: number,
): Promise<void> {
  if (!Number.isFinite(portfolioValue) || portfolioValue <= 0) return;
  const c = await redis();
  await c.set(monthKey(userId), String(portfolioValue), { EX: TTL_SECONDS, NX: true });
}

export async function getMtdAnchor(userId: string): Promise<number | null> {
  const c = await redis();
  const val = await c.get(monthKey(userId));
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}
