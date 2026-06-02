// Real IBKR conid resolver for the screener universe (Batch S1.5).
//
// Calls ibSecdefSearch(symbol) and picks the first US STK match. IB's
// /iserver/secdef/search returns multiple matches per symbol when the
// ticker exists across exchanges (e.g. MNTS = Momentus Inc on NASDAQ vs
// Schiehallion Fund on LSE; REPL = Replimune on NASDAQ vs Rudrabhishek
// Enterprises on NSE) — we filter to {NASDAQ, NYSE, AMEX} and require a
// STK section.
//
// Spec: spec/signals/screener-universe.md → Conid resolution.

import { ibSecdefSearch } from '../ibGateway.js';
import { pickUsStockMatch, type PickedConid } from './conidPicker.js';

export { pickUsStockMatch } from './conidPicker.js';
export type { PickedConid } from './conidPicker.js';
export type ResolveResult = PickedConid;

/**
 * End-to-end resolution. Calls IB then runs the picker. Throws on the
 * IB error path (network / 401 / 503) so the worker framework can mark
 * the job failed; returns null when IB responded fine but had no US STK
 * match — caller decides what to do with an unresolvable symbol.
 */
export async function resolveConid(symbol: string): Promise<PickedConid | null> {
  const results = await ibSecdefSearch(symbol);
  return pickUsStockMatch(results);
}
