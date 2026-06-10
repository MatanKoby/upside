// Canonical-quote write helper (Batch A1).
//
// The `quotes` table holds BOTH IB and Finnhub prices side-by-side per conid,
// plus a denormalized `canonical_*` triple (see spec/schema.md). Each poller
// writes only its own source's columns + the canonical pointer when it is
// currently authoritative — IB always wins when connected; Finnhub only sets
// the canonical when IB is unavailable.
//
// Idempotent UPSERTs keyed by conid. Symbol is also written so FE doesn't have
// to join contracts to render rows.

import { supabase } from './supabase.js';
import { dailyBarsTableModule } from '../db/dailyBarsTableModule.js';
import { universeTableModule } from '../db/universeTableModule.js';
import { quotesTableModule, type DailySeedRow } from '../db/quotesTableModule.js';
import { notifyError } from './notify.js';
import { checkMarkersForConid } from './markers.js';
import { checkEntryZonesForConid } from './entryZoneAlerts.js';
import { checkIntradayStatsForConid } from './intradayStatsAlerts.js';

export type QuoteSource = 'ib' | 'finnhub';

interface QuoteWriteOpts {
  conid: number;
  symbol: string;
  source: QuoteSource;
  price: number;
  /**
   * When true (the default for IB; for Finnhub only when IB is currently
   * disconnected), this write also stamps the canonical_* triple.
   */
  setCanonical?: boolean;
  /** Today's change in percent (open/prev-close relative). Optional. */
  todayChangePct?: number | null;
  /** Today's open price. Used by the stats-alert engine to compute the
   *  typical-intraday-low band. Optional. */
  todayOpen?: number | null;
  now?: string;
}

export async function upsertQuote(opts: QuoteWriteOpts): Promise<void> {
  if (!Number.isFinite(opts.conid) || !Number.isFinite(opts.price)) return;
  const now = opts.now ?? new Date().toISOString();
  const setCanonical = opts.setCanonical ?? (opts.source === 'ib');

  // Read the prior canonical_price so the marker check (Batch A2) can detect
  // a transition. This adds one SELECT per write — cheap, but only needed
  // when we're updating the canonical (Finnhub writes that don't set
  // canonical skip the check to avoid spurious fires from a non-authoritative
  // source). null on the very first write for a conid; markers.ts skips in
  // that case.
  let prevCanonical: number | null = null;
  if (setCanonical) {
    try {
      prevCanonical = await quotesTableModule.getCanonicalPrice(opts.conid);
    } catch {
      prevCanonical = null;
    }
  }

  try {
    await quotesTableModule.upsertLiveQuote({
      conid: opts.conid,
      symbol: opts.symbol,
      source: opts.source,
      price: opts.price,
      setCanonical,
      now,
      todayChangePct: opts.todayChangePct,
      todayOpen: opts.todayOpen,
    });
  } catch (e) {
    void notifyError('quotes.upsertQuote', (e as Error).message);
  }

  // Marker check + entry-zone check — both run on every canonical price
  // transition (Batches A2 + A+). Fire-and-forget; each function handles its
  // own internal failure notifications.
  if (setCanonical) {
    void checkMarkersForConid(opts.conid, opts.symbol, prevCanonical, opts.price);
    void checkEntryZonesForConid(opts.conid, opts.symbol, prevCanonical, opts.price);
    void checkIntradayStatsForConid(opts.conid, opts.symbol, prevCanonical, opts.price);
  }
}

/**
 * Seed a daily-close `quotes` row for curated/universe conids that have no live
 * quote (Batch X9). The virtual lists + the dip-bounce scorer read `quotes`, but
 * only held/watchlist names were ever quoted — curated names were dropped on the
 * join. Price comes from `universe.last_price` (Polygon daily, batched) with the
 * `daily_bars` last close as fallback + a 20-point sparkline. Marked
 * `canonical_source='daily'` with the bar date as an honest (stale) timestamp, so
 * the fresh-price firing gate skips them (render, don't fire). NEVER clobbers a
 * row a live poller owns (ib/finnhub canonical). Returns the number seeded.
 */
export async function seedDailyQuotes(conids: number[]): Promise<number> {
  const uniq = [...new Set(conids.filter((c) => Number.isFinite(c)))];
  if (uniq.length === 0) return 0;

  // Global latest daily-bar date → the honest as-of stamp for all seeded rows.
  const latestBarDate = await dailyBarsTableModule.latestDate();
  const asOfStamp = latestBarDate ? `${latestBarDate}T21:00:00.000Z` : new Date().toISOString();

  // universe price + symbol (keyed by real_conid), and which conids a live poller owns.
  const uni = new Map<number, { symbol: string; price: number | null }>();
  const liveOwned = new Set<number>();
  const sparkByConid = new Map<number, number[]>();
  const barCutoff = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);

  // Sparkline closes from the daily_bars SSOT (last ~40d), each chunk date-asc
  // so per-conid order is chronological.
  for (const r of await dailyBarsTableModule.getClosesSince(uniq, barCutoff)) {
    (sparkByConid.get(r.conid) ?? sparkByConid.set(r.conid, []).get(r.conid)!).push(r.c);
  }

  // universe price + symbol (keyed by real_conid), via the universe TableModule.
  for (const r of await universeTableModule.getByRealConids(uniq)) {
    if (r.realConid != null) uni.set(r.realConid, { symbol: r.symbol, price: r.lastPrice });
  }

  // Which conids a live poller owns — never clobber a live (ib/finnhub) row.
  for (const s of await quotesTableModule.getCanonicalSnapshots(uniq)) {
    if (s.canonicalSource === 'ib' || s.canonicalSource === 'finnhub') liveOwned.add(s.conid);
  }

  const rows: DailySeedRow[] = [];
  for (const conid of uniq) {
    if (liveOwned.has(conid)) continue; // a live poller owns this row — never overwrite
    const u = uni.get(conid);
    if (!u || !u.symbol) continue;
    const closes = sparkByConid.get(conid) ?? [];
    const price = u.price ?? (closes.length ? closes[closes.length - 1] : null);
    if (price == null) continue;
    rows.push({
      conid,
      symbol: u.symbol,
      canonicalPrice: price,
      canonicalUpdatedAt: asOfStamp,
      sparklineCloses: closes.length ? closes.slice(-20) : null,
    });
  }

  try {
    await quotesTableModule.upsertDailySeeds(rows);
  } catch (e) {
    void notifyError('quotes.seedDailyQuotes', (e as Error).message);
  }
  return rows.length;
}

/**
 * Active-list watchlist conids minus held conids — the set the watchlist
 * quote poller needs to cover (held conids are already priced by the main
 * pollers). Returns the (conid, symbol) pairs deduped by conid.
 */
export async function activeWatchlistOnlyConids(
  heldConids: Set<number>,
): Promise<Array<{ conid: number; symbol: string }>> {
  // Two queries — first the active list ids, then their items. PostgREST
  // doesn't support a single-query JOIN-with-filter the way we'd want it.
  const lists = await supabase()
    .from('watchlist_lists')
    .select('id')
    .eq('active', true);
  const listIds = (lists.data ?? []).map((r) => r.id as string);
  if (listIds.length === 0) return [];

  const items = await supabase()
    .from('watchlist_items')
    .select('conid, symbol')
    .in('list_id', listIds);

  const out = new Map<number, string>();
  for (const r of items.data ?? []) {
    const conid = Number(r.conid);
    if (!Number.isFinite(conid) || heldConids.has(conid)) continue;
    if (!out.has(conid)) out.set(conid, String(r.symbol ?? ''));
  }
  return Array.from(out, ([conid, symbol]) => ({ conid, symbol }));
}
