// TableModule for `positions` — the SOLE server-side gatekeeper for the user's
// holdings (spec/schema.md → positions). The holdings write-path: the IB poller
// is the authoritative writer (full sync — upsert held facts, delete orphans),
// the Finnhub fallback poller stamps price-source + zone metadata, and a daily
// cleanup clears the per-day gap badge. Many readers (portfolio routes, the
// analysis engine, the watchlist/news/risk working-set builders) project a held
// slice out of it.
//
//   Writers (one owner):
//     - ibPricePoller   → full holdings sync: upsertHoldings + deleteOrphans +
//                         deleteAllForUser (the "no positions" zero-out)
//     - finnhubPricePoller → markFinnhubPriced (price-source + recomputed zone)
//     - zoneGapCleanup  → clearGapBadges (end-of-day "entered via gap" reset)
//   Readers: portfolio (/positions, /summary), marketdata (resolveConid),
//     signalEngine, finnhubPricePoller (stale-fill), watchlistQuotePoller,
//     riskFlagsCron, newsSentimentCron, dipBounce.computeSet, the health probe.
//
// Batch ARCH-3 (rollout slice 10 — the holdings hub). Price/P&L moved to `quotes`
// (Batch X5); positions carries only holding facts. The module owns the column
// names + the write-column projection; the *policy* (entry-date reconciliation,
// change-detection, profit-zone transitions, the quotes mirror) stays in the
// pollers. Same SQL, no behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';
import { supabase } from '../services/supabase.js';
import type { ZoneFields } from '../services/profitZone.js';

// A fully-assembled position as the IB poller builds it each cycle. Snake_case
// because it mirrors the DB row 1:1 and is the cron's in-memory assembly buffer:
// it also carries the price/P&L fields (current_price, market_value, …) that are
// NOT persisted (they live in `quotes` now — Batch X5) but still feed the quotes
// mirror, the MTD stamp, and the profit-zone math in the poller. `upsertHoldings`
// restricts the write to POSITION_WRITE_COLUMNS.
export interface AssembledPosition {
  user_id: string;
  conid: number;
  account_id: string;
  symbol: string;
  company_name: string | null;
  shares: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number | null;
  realized_pnl: number | null;
  today_change: number | null;
  today_change_pct: number | null;
  vwap_value: number | null;
  vwap_updated_at: string | null;
  portfolio_weight: number;
  portfolio_contribution: number;
  daily_return: number | null;
  trading_days_held: number | null;
  first_seen_at: string;
  first_seen_source: 'observed' | 'ib_transactions';
  currency: string;
  asset_class: string;
  industry: string | null;
  category: string | null;
  price_source: 'ib';
  last_price_update_at: string;
  updated_at: string;
  zone_entered_at: string | null;
  zone_exited_at: string | null;
  last_zone_notification_at: string | null;
  entered_zone_via_gap: boolean;
}

// Columns persisted to `positions` (Batch X5): holding facts only. Price + P&L
// (current_price / market_value / unrealized_pnl[_pct] / today_change[_pct] /
// daily_return / portfolio_weight / portfolio_contribution) live in `quotes` /
// are recomputed by readers, so they're dropped from the write even though the
// assembled object still carries them in-memory.
const POSITION_WRITE_COLUMNS = [
  'user_id', 'conid', 'account_id', 'symbol', 'company_name', 'shares', 'avg_cost',
  'realized_pnl', 'vwap_value', 'vwap_updated_at', 'trading_days_held',
  'first_seen_at', 'first_seen_source', 'currency', 'asset_class', 'industry',
  'category', 'price_source', 'last_price_update_at', 'updated_at',
  'zone_entered_at', 'zone_exited_at', 'last_zone_notification_at', 'entered_zone_via_gap',
] as const;

function toPositionRow(a: AssembledPosition): Record<string, unknown> {
  const src = a as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of POSITION_WRITE_COLUMNS) out[k] = src[k];
  return out;
}

/** The holding-facts slice the IB poller reads back for change-detection,
 *  entry-date preservation, and prior profit-zone state (camelCase). */
export interface ExistingHolding {
  symbol: string;
  vwapValue: number | null;
  shares: number | null;
  avgCost: number | null;
  firstSeenAt: string | null;
  firstSeenSource: string | null;
  zoneEnteredAt: string | null;
  zoneExitedAt: string | null;
  lastZoneNotificationAt: string | null;
  enteredZoneViaGap: boolean;
}

/** The slice the Finnhub fallback poller reads to decide which held rows are
 *  stale and to recompute their profit-zone state (camelCase). */
export interface PriceFillRow {
  symbol: string;
  conid: number | null;
  shares: number | null;
  avgCost: number | null;
  lastPriceUpdateAt: string | null;
  zoneEnteredAt: string | null;
  zoneExitedAt: string | null;
  lastZoneNotificationAt: string | null;
  enteredZoneViaGap: boolean | null;
}

/** Cost-basis slice for the portfolio /summary value + P&L recompute. */
export interface HeldCostBasis {
  conid: number | null;
  shares: number | string | null;
  avgCost: number | string | null;
}

/** The held-row detail the analysis engine needs (direction, conid, zone). */
export interface PositionDetail {
  conid: number | null;
  symbol: string;
  companyName: string | null;
  shares: number | null;
  avgCost: number | null;
  zoneEnteredAt: string | null;
  enteredZoneViaGap: boolean;
}

const HOLDING_FACTS_COLS =
  'symbol, vwap_value, shares, avg_cost, first_seen_at, first_seen_source, zone_entered_at, zone_exited_at, last_zone_notification_at, entered_zone_via_gap';
const PRICE_FILL_COLS =
  'symbol, conid, shares, avg_cost, last_price_update_at, zone_entered_at, zone_exited_at, last_zone_notification_at, entered_zone_via_gap';

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

class PositionsTableModule extends TableModule {
  constructor() {
    super('positions');
  }

  // --- writers (the holdings sync owner) -----------------------------------

  /** Upsert the changed holding rows on the (user_id, symbol) key, restricting
   *  the write to the holding-fact columns. The IB poller's change-detection
   *  decides *which* rows land here. */
  async upsertHoldings(positions: AssembledPosition[]): Promise<void> {
    if (positions.length === 0) return;
    await this.run('upsertHoldings', this.from().upsert(positions.map(toPositionRow), { onConflict: 'user_id,symbol' }));
  }

  /** Zero out every row for a user (the "no positions returned" case). */
  async deleteAllForUser(userId: string): Promise<void> {
    await this.run('deleteAllForUser', this.from().delete().eq('user_id', userId));
  }

  /** Delete a user's rows for symbols no longer held (orphan sweep). */
  async deleteOrphans(userId: string, symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
    await this.run('deleteOrphans', this.from().delete().eq('user_id', userId).in('symbol', symbols));
  }

  /** Stamp price-source = 'finnhub' + recomputed zone state on a held row.
   *  Throws on failure; the caller preserves the per-symbol notify + continue. */
  async markFinnhubPriced(userId: string, symbol: string, nowIso: string, zone: ZoneFields): Promise<void> {
    await this.run(
      'markFinnhubPriced',
      this.from()
        .update({ price_source: 'finnhub', last_price_update_at: nowIso, updated_at: nowIso, ...zone })
        .eq('user_id', userId)
        .eq('symbol', symbol),
    );
  }

  /** Clear the per-trading-day "entered via gap" badge for all rows that set it. */
  async clearGapBadges(): Promise<void> {
    await this.run('clearGapBadges', this.from().update({ entered_zone_via_gap: false }).eq('entered_zone_via_gap', true));
  }

  // --- readers -------------------------------------------------------------

  /** Every row for a user, ordered by symbol — the /positions route ships these
   *  straight to the FE, so they stay in the DB's snake_case wire shape. */
  async getAllForUser(userId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.run<Record<string, unknown>[]>(
      'getAllForUser',
      this.from().select('*').eq('user_id', userId).order('symbol', { ascending: true }),
    );
    return rows ?? [];
  }

  /** Cost-basis slice for a user (the /summary value + P&L recompute). */
  async getHeldCostBasis(userId: string): Promise<HeldCostBasis[]> {
    const rows = await this.run<Array<{ conid: unknown; shares: unknown; avg_cost: unknown }>>(
      'getHeldCostBasis',
      this.from().select('conid, shares, avg_cost').eq('user_id', userId),
    );
    return (rows ?? []).map((r) => ({
      conid: num(r.conid),
      shares: r.shares as number | string | null,
      avgCost: r.avg_cost as number | string | null,
    }));
  }

  /** Conid for a held symbol (the marketdata charting lookup). Null when the
   *  symbol isn't held. */
  async getConidBySymbol(userId: string, symbol: string): Promise<number | null> {
    const r = await this.run<{ conid: unknown } | null>(
      'getConidBySymbol',
      this.from().select('conid').eq('user_id', userId).eq('symbol', symbol).maybeSingle(),
    );
    return num(r?.conid);
  }

  /** Holding-fact slice for a user — the IB poller's change-detection read. */
  async getHoldingFactsForUser(userId: string): Promise<ExistingHolding[]> {
    const rows = await this.run<Array<Record<string, unknown>>>(
      'getHoldingFactsForUser',
      this.from().select(HOLDING_FACTS_COLS).eq('user_id', userId),
    );
    return (rows ?? []).map((r) => ({
      symbol: String(r.symbol ?? ''),
      vwapValue: num(r.vwap_value),
      shares: num(r.shares),
      avgCost: num(r.avg_cost),
      firstSeenAt: str(r.first_seen_at),
      firstSeenSource: str(r.first_seen_source),
      zoneEnteredAt: str(r.zone_entered_at),
      zoneExitedAt: str(r.zone_exited_at),
      lastZoneNotificationAt: str(r.last_zone_notification_at),
      enteredZoneViaGap: Boolean(r.entered_zone_via_gap),
    }));
  }

  /** Price-fill slice for a user — the Finnhub fallback poller's stale read. */
  async getPriceFillRowsForUser(userId: string): Promise<PriceFillRow[]> {
    const rows = await this.run<Array<Record<string, unknown>>>(
      'getPriceFillRowsForUser',
      this.from().select(PRICE_FILL_COLS).eq('user_id', userId),
    );
    return (rows ?? []).map((r) => ({
      symbol: String(r.symbol ?? ''),
      conid: num(r.conid),
      shares: num(r.shares),
      avgCost: num(r.avg_cost),
      lastPriceUpdateAt: str(r.last_price_update_at),
      zoneEnteredAt: str(r.zone_entered_at),
      zoneExitedAt: str(r.zone_exited_at),
      lastZoneNotificationAt: str(r.last_zone_notification_at),
      enteredZoneViaGap: r.entered_zone_via_gap == null ? null : Boolean(r.entered_zone_via_gap),
    }));
  }

  /** Every held conid across all users (single-user app) — watchlist gap closer. */
  async getAllHeldConids(): Promise<number[]> {
    const rows = await this.run<Array<{ conid: unknown }>>('getAllHeldConids', this.from().select('conid'));
    const out: number[] = [];
    for (const r of rows ?? []) {
      const c = num(r.conid);
      if (c != null) out.push(c);
    }
    return out;
  }

  /** Every held (conid, symbol) — the news/risk/dip-bounce working-set seed. */
  async getAllHeldConidSymbols(): Promise<Array<{ conid: number; symbol: string }>> {
    const rows = await this.run<Array<{ conid: unknown; symbol: unknown }>>(
      'getAllHeldConidSymbols',
      this.from().select('conid, symbol'),
    );
    const out: Array<{ conid: number; symbol: string }> = [];
    for (const r of rows ?? []) {
      const c = num(r.conid);
      if (c != null && r.symbol) out.push({ conid: c, symbol: String(r.symbol) });
    }
    return out;
  }

  /** The held-row detail for one (user, symbol) — the analysis engine read. */
  async getByUserAndSymbol(userId: string, symbol: string): Promise<PositionDetail | null> {
    const r = await this.run<Record<string, unknown> | null>(
      'getByUserAndSymbol',
      this.from()
        .select('conid, symbol, company_name, shares, avg_cost, zone_entered_at, entered_zone_via_gap')
        .eq('user_id', userId)
        .eq('symbol', symbol)
        .maybeSingle(),
    );
    if (!r) return null;
    return {
      conid: num(r.conid),
      symbol: String(r.symbol ?? ''),
      companyName: str(r.company_name),
      shares: num(r.shares),
      avgCost: num(r.avg_cost),
      zoneEnteredAt: str(r.zone_entered_at),
      enteredZoneViaGap: Boolean(r.entered_zone_via_gap),
    };
  }

  /** DB-reachability probe (the /healthz + keepalive check). Returns false on
   *  any error rather than throwing — it's a liveness signal, not a query. */
  async ping(): Promise<boolean> {
    const { error } = await supabase().from('positions').select('symbol').limit(1);
    return !error;
  }
}

export const positionsTableModule = new PositionsTableModule();
