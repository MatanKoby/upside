// Entry-date deduction (Batch 13.5) — pure logic, no IB access. Two data
// sources, because neither alone is sufficient:
//
//  • /iserver/account/trades — per-execution INTRADAY timestamps (trade_time_r),
//    but only ~7 days of history. `size` is unsigned + a `side` ('B'/'S') field.
//    Catches a recent flatten + re-open (sell-to-0 then re-buy same day), which
//    is the *true* entry and which day-level data cannot see.
//  • POST /pa/transactions — ~90 days, but DAY-LEVEL only (dates are 00:00:00
//    and the array order is unreliable). `qty` is ALREADY SIGNED. Fallback for
//    positions whose entry predates the 7-day trades window.
//
// entryFromTrades() is tried first (intraday-accurate); entryFromTransactions()
// (day-level, order-independent) is the fallback. Inherent limit: an intraday
// flatten that happened >7 days ago is unrecoverable from IB.

import type { RawIbTrade, RawIbTransaction } from './port.js';

/**
 * Intraday-accurate entry from the ~7-day trades window. Back-computes the
 * share balance just before the window (currentShares − Σ window fills for the
 * conid), then walks the conid's fills in execution-time order, returning the
 * timestamp of the most recent 0→positive crossing (a re-open). Returns null
 * when the position was already open before the window and never flattened in
 * it — i.e. the entry predates the trades window, so the caller falls back to
 * day-level transactions.
 */
export function entryFromTrades(
  trades: RawIbTrade[],
  conid: number,
  currentShares: number,
): Date | null {
  const fills = trades
    .filter((t) => Number(t.conid) === conid && typeof t.trade_time_r === 'number')
    .map((t) => {
      const size = typeof t.size === 'number' ? t.size : 0;
      const side = (t.side ?? '').toUpperCase();
      return { timeMs: t.trade_time_r as number, signed: side === 'S' ? -size : size };
    })
    .sort((a, b) => a.timeMs - b.timeMs);
  if (fills.length === 0) return null;

  const windowNet = fills.reduce((sum, f) => sum + f.signed, 0);
  let running = currentShares - windowNet; // balance just before the window
  let entry: Date | null = null;
  for (const f of fills) {
    const prev = running;
    running += f.signed;
    if (prev <= 0 && running > 0) entry = new Date(f.timeMs);
    if (running <= 0) entry = null;
  }
  return entry; // null ⇒ no flatten/re-open inside the window ⇒ entry is older
}

/**
 * Day-level fallback entry from /pa/transactions: aggregate net signed `qty`
 * per calendar day, walk end-of-day balances, return the most recent day the
 * balance crossed 0→positive. Order-independent (robust to IB's unreliable
 * same-day ordering) but blind to intraday flattens — used only for entries
 * older than the ~7-day trades window, where intraday data no longer exists.
 * Returns null if the 90-day window doesn't reconcile to currentShares.
 */
export function entryFromTransactions(
  transactions: RawIbTransaction[],
  currentShares: number,
): Date | null {
  const byDay = new Map<string, { date: Date; net: number }>();
  for (const tx of transactions) {
    if (!tx.date) continue;
    if (tx.type) {
      const t = tx.type.toLowerCase();
      if (!t.includes('buy') && !t.includes('sell')) continue; // skip non-trades
    }
    const d = new Date(tx.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = tx.rawDate ?? tx.date;
    const qty = typeof tx.qty === 'number' ? tx.qty : 0; // pa `qty` is pre-signed
    const cur = byDay.get(key) ?? { date: d, net: 0 };
    cur.net += qty;
    byDay.set(key, cur);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = 0;
  let entry: Date | null = null;
  for (const day of days) {
    const prev = running;
    running += day.net;
    if (prev <= 0 && running > 0) entry = day.date;
    if (running <= 0) entry = null;
  }
  if (Math.abs(running - currentShares) > 0.0001) return null;
  return entry;
}
