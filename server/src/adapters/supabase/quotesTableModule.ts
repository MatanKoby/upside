// TableModule for `quotes` — the SOLE server-side gatekeeper for the canonical
// price surface (spec/schema.md → quotes; the price SSOT, Batch X5). The hub
// table of the screener: a handful of writers and ~half the crons read it.
//
//   Writers (one owner):
//     - quotes.upsertQuote  → the live canonical write (IB + Finnhub + watchlist
//                             pollers all funnel through it) — source-specific
//                             price columns + the canonical_* triple
//     - quotes.seedDailyQuotes → daily-close seed rows for curated/universe names
//     - entryZonesCron      → the 7-close sparkline payload (piggybacked write)
//   Readers: portfolio route, signalEngine, signalOutcomesCron, riskFlagsCron,
//     entryZonesCron, intradayStatsAlerts, intradayRangeTraderProducer,
//     newsSentimentCron, dipBounceCron, quotes.seedDailyQuotes.
//
// Batch ARCH-3 (rollout slice 9 — the 5-writer hub). The module owns the column
// names + snake↔camel mapping; the *policy* (which source is authoritative, the
// prev-canonical transition probe, freshness/ownership gates) stays in the
// services. Same SQL, no behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

/** A live canonical write as the pollers produce it (camelCase). The module
 *  maps to the source-specific price columns + the canonical_* triple. */
export interface QuoteUpsert {
  conid: number;
  symbol: string;
  source: 'ib' | 'finnhub';
  price: number;
  /** Also stamp the canonical_* triple (IB always; Finnhub only when IB is down). */
  setCanonical: boolean;
  now: string; // ISO
  todayChangePct?: number | null;
  todayOpen?: number | null;
}

/** A daily-close seed row (Batch X9) — a stale canonical price for a name no
 *  live poller owns, stamped `canonical_source='daily'`. */
export interface DailySeedRow {
  conid: number;
  symbol: string;
  canonicalPrice: number;
  canonicalUpdatedAt: string; // ISO — the honest (stale) bar stamp
  sparklineCloses: number[] | null;
}

/** The canonical snapshot the freshness/ownership readers consume. */
export interface CanonicalSnapshot {
  conid: number;
  canonicalPrice: number | null;
  todayOpen: number | null;
  canonicalSource: string | null;
  canonicalUpdatedAt: string | null;
}

const READ_CHUNK = 900;
const WRITE_CHUNK = 500;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class QuotesTableModule extends TableModule {
  constructor() {
    super('quotes');
  }

  // --- writers -------------------------------------------------------------

  /** Upsert one live quote on the `conid` PK. Writes only the source's own
   *  price columns, plus the canonical_* triple when `setCanonical`. Mirrors the
   *  exact column policy the pollers relied on (finite/positive guards). */
  async upsertLiveQuote(u: QuoteUpsert): Promise<void> {
    const row: Record<string, unknown> = { conid: u.conid, symbol: u.symbol };
    if (u.source === 'ib') {
      row.ib_price = u.price;
      row.ib_updated_at = u.now;
    } else {
      row.finnhub_price = u.price;
      row.finnhub_updated_at = u.now;
    }
    if (u.setCanonical) {
      row.canonical_price = u.price;
      row.canonical_source = u.source;
      row.canonical_updated_at = u.now;
    }
    if (u.todayChangePct != null && Number.isFinite(u.todayChangePct)) {
      row.today_change_pct = u.todayChangePct;
    }
    if (u.todayOpen != null && Number.isFinite(u.todayOpen) && u.todayOpen > 0) {
      row.today_open = u.todayOpen;
    }
    await this.run('upsertLiveQuote', this.from().upsert(row, { onConflict: 'conid' }));
  }

  /** Bulk-upsert daily-close seed rows on the `conid` PK, chunked. Stamped
   *  `canonical_source='daily'` so the fresh-price firing gate skips them. */
  async upsertDailySeeds(rows: DailySeedRow[]): Promise<void> {
    if (rows.length === 0) return;
    const mapped = rows.map((r) => ({
      conid: r.conid,
      symbol: r.symbol,
      canonical_price: r.canonicalPrice,
      canonical_source: 'daily',
      canonical_updated_at: r.canonicalUpdatedAt,
      sparkline_closes: r.sparklineCloses,
    }));
    for (let i = 0; i < mapped.length; i += WRITE_CHUNK) {
      await this.run('upsertDailySeeds', this.from().upsert(mapped.slice(i, i + WRITE_CHUNK), { onConflict: 'conid' }));
    }
  }

  /** Write the entry-zone cron's 7-close sparkline payload onto a quote row. */
  async setSparkline(conid: number, closes: number[]): Promise<void> {
    await this.run('setSparkline', this.from().update({ sparkline_closes: closes }).eq('conid', conid));
  }

  // --- readers -------------------------------------------------------------

  /** Canonical price for one conid, or null when absent/non-finite. Also serves
   *  the upsertQuote prev-canonical transition probe. */
  async getCanonicalPrice(conid: number): Promise<number | null> {
    const r = await this.run<{ canonical_price: unknown } | null>(
      'getCanonicalPrice',
      this.from().select('canonical_price').eq('conid', conid).maybeSingle(),
    );
    return num(r?.canonical_price);
  }

  /** Canonical prices for a set of conids → conid→price map (finite only),
   *  chunked. The held-value + outcome-pricing readers. */
  async getCanonicalPrices(conids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const uniq = [...new Set(conids)];
    for (let i = 0; i < uniq.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: unknown; canonical_price: unknown }>>(
        'getCanonicalPrices',
        this.from().select('conid, canonical_price').in('conid', uniq.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        const c = num(r.conid);
        const p = num(r.canonical_price);
        if (c != null && p != null) out.set(c, p);
      }
    }
    return out;
  }

  /** Today's open for one conid (the stats-alert band projection). */
  async getTodayOpen(conid: number): Promise<number | null> {
    const r = await this.run<{ today_open: unknown } | null>(
      'getTodayOpen',
      this.from().select('today_open').eq('conid', conid).maybeSingle(),
    );
    return num(r?.today_open);
  }

  /** Today's open for a set of conids (the band-low projection join). */
  async getTodayOpens(conids: number[]): Promise<Array<{ conid: number; todayOpen: number | null }>> {
    const out: Array<{ conid: number; todayOpen: number | null }> = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: unknown; today_open: unknown }>>(
        'getTodayOpens',
        this.from().select('conid, today_open').in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        const c = num(r.conid);
        if (c != null) out.push({ conid: c, todayOpen: num(r.today_open) });
      }
    }
    return out;
  }

  /** (conid, symbol) for a set of conids — the symbol-resolution reader (curated
   *  names whose symbol the consumer doesn't otherwise carry). */
  async getSymbols(conids: number[]): Promise<Array<{ conid: number; symbol: string }>> {
    const out: Array<{ conid: number; symbol: string }> = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: unknown; symbol: unknown }>>(
        'getSymbols',
        this.from().select('conid, symbol').in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        const c = num(r.conid);
        if (c != null && r.symbol) out.push({ conid: c, symbol: String(r.symbol) });
      }
    }
    return out;
  }

  /** Canonical snapshots (price + open + source + stamp) for a set of conids,
   *  chunked. The freshness gate (dipBounce) + the daily-seed ownership probe
   *  read this and apply their own policy. */
  async getCanonicalSnapshots(conids: number[]): Promise<CanonicalSnapshot[]> {
    const out: CanonicalSnapshot[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<
        Array<{ conid: unknown; canonical_price: unknown; today_open: unknown; canonical_source: unknown; canonical_updated_at: unknown }>
      >(
        'getCanonicalSnapshots',
        this.from()
          .select('conid, canonical_price, today_open, canonical_source, canonical_updated_at')
          .in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        const c = num(r.conid);
        if (c == null) continue;
        out.push({
          conid: c,
          canonicalPrice: num(r.canonical_price),
          todayOpen: num(r.today_open),
          canonicalSource: r.canonical_source == null ? null : String(r.canonical_source),
          canonicalUpdatedAt: r.canonical_updated_at == null ? null : String(r.canonical_updated_at),
        });
      }
    }
    return out;
  }
}

export const quotesTableModule = new QuotesTableModule();
