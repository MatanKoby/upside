// Pure US-STK match picker for IB secdef/search responses (Batch S1.5).
//
// Lives separately from conidResolver.ts (which imports the ibGateway
// HTTP client) so vitest can exercise the disambiguation logic without
// loading supabase + env at module init. Same separation pattern as
// jobs/keys.ts vs jobs/queue.ts.

import type { RawIbSecdefResult } from '../../types/index.js';

const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'AMEX']);

export interface PickedConid {
  conid: number;
  exchange: 'NASDAQ' | 'NYSE' | 'AMEX';
}

/**
 * Scan a secdef/search response and pick the first US STK match.
 *   - Top-level `description` ∈ {NASDAQ, NYSE, AMEX} filters to US listings.
 *   - Must have at least one section with `secType='STK'` (skips
 *     options-only / warrant-only results).
 *   - First-listed wins for dual US listings (IB orders by relevance).
 */
export function pickUsStockMatch(results: RawIbSecdefResult[]): PickedConid | null {
  for (const r of results) {
    if (!r || typeof r.description !== 'string') continue;
    if (!US_EXCHANGES.has(r.description)) continue;
    const sections = Array.isArray(r.sections) ? r.sections : [];
    const hasStk = sections.some((s) => s?.secType === 'STK');
    if (!hasStk) continue;
    const n = Number(r.conid);
    if (!Number.isFinite(n) || n <= 0) continue;
    return { conid: n, exchange: r.description as PickedConid['exchange'] };
  }
  return null;
}
