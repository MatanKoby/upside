// Pure-function Ring-1 filter for the screener universe (Batch S1).
//
// Spec: spec/signals/screener-universe.md → Universe → Ring 1.
// Schema: spec/schema.md → universe.filter_result enum.
//
// Two-stage filter:
//   - Pre-DB (type + MIC) — applied in-process by the cron *before* any
//     per-symbol API call. Saves ~25k Finnhub calls per nightly sweep.
//   - DB-recorded (price + cap, eventually volume) — applied per symbol with
//     fresh /quote + /stock/profile2 data; the result enum is stored on the
//     `universe` row so we can diagnose "why did this drop out?" without
//     re-running the sweep.
//
// The pre-DB enum results (`out_type`, `out_mic`) are surfaced here for
// testing + diagnostic completeness but are never written to the DB — those
// symbols are skipped before insert.

export type FilterResult =
  | 'in'           // passed all gates → screener-eligible
  | 'out_type'     // type ∉ {Common Stock, ADR} — never reaches DB
  | 'out_mic'      // exchange MIC ∉ {XNAS, XNYS, XASE} — never reaches DB
  | 'out_price'    // last price outside [MIN_PRICE_USD, MAX_PRICE_USD]
  | 'out_cap'      // market cap below MIN_MARKET_CAP_M (millions)
  | 'out_volume'   // 30d avg vol below MIN_AVG_VOLUME (shares) — gate deferred
  | 'no_data';     // /quote or /profile2 returned nothing usable

export interface FilterInput {
  type: string | null;
  mic: string | null;
  price: number | null;        // last quote price in USD
  marketCapM: number | null;   // market cap in MILLIONS (Finnhub's native unit)
  avgVolume: number | null;    // 30d average daily volume in shares; null = unknown
}

export const ALLOWED_TYPES = new Set(['Common Stock', 'ADR']);
export const ALLOWED_MICS = new Set(['XNAS', 'XNYS', 'XASE']);

// User-picked thresholds — see spec/signals/screener-universe.md → Ring 1.
export const MIN_PRICE_USD = 1;
export const MAX_PRICE_USD = 100;
export const MIN_MARKET_CAP_M = 150;
export const MIN_AVG_VOLUME = 1_000_000;

/** Pure Ring-1 evaluation. Order of checks mirrors the rejection-cost
 *  ordering (cheap first) so each symbol exits as soon as a gate fails. */
export function filterRing1(input: FilterInput): FilterResult {
  if (!input.type || !ALLOWED_TYPES.has(input.type)) return 'out_type';
  if (!input.mic || !ALLOWED_MICS.has(input.mic)) return 'out_mic';

  // Finnhub returns 0 for unknown / closed-market quotes; treat as missing.
  if (input.price == null || input.price === 0) return 'no_data';
  if (input.price < MIN_PRICE_USD || input.price > MAX_PRICE_USD) return 'out_price';

  if (input.marketCapM == null) return 'no_data';
  if (input.marketCapM < MIN_MARKET_CAP_M) return 'out_cap';

  // Volume gate is opt-in for v1 — null avg-volume means "skip this gate"
  // until S2 wires the daily-bar pipeline. Non-null below floor still fails.
  if (input.avgVolume != null && input.avgVolume < MIN_AVG_VOLUME) return 'out_volume';

  return 'in';
}

/** Quick pre-DB sieve for the Finnhub /stock/symbol payload. The cron uses
 *  this to drop ~25k of the ~30k initial rows BEFORE making any per-symbol
 *  call, saving most of the rate-limit budget. */
export function preFilterByTypeAndMic(
  row: { type?: string | null; mic?: string | null },
): boolean {
  return (
    !!row.type &&
    ALLOWED_TYPES.has(row.type) &&
    !!row.mic &&
    ALLOWED_MICS.has(row.mic)
  );
}
