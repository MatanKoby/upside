// TableModule for `universe` — the SOLE server-side gatekeeper for the screener
// universe (~3–5k Ring-1 rows). The first MULTI-WRITER table of the rollout, so
// the one-writer-owner rule does real work: six producers/crons mutate universe,
// but every column write + every read shape now lives here behind named methods.
//
//   Writers (all one owner):
//     - universeCron            → bulk upsert of the nightly sweep + stale retention
//     - conidResolutionProducer → stamp real_conid once IB resolves it
//     - marketCapRefreshCron    → refresh last_market_cap_m weekly
//     - universeQuoteProducer   → daily last_price/last_volume + refresh_universe_avg_volume
//     - catalystReversalProducer→ mark auto_promoted carryovers
//   Readers: marketCapRefresh, conidResolution, intradayStats(Cron), the two
//     event producers (catalyst / post-earnings), intradayRangeTrader,
//     quotes.seedDailyQuotes, dipBounce.computeSet.
//
// Batch ARCH-3 (rollout slice 8 — first of the multi-writer half). Same SQL,
// same columns — just relocated and named. No behavior change. The synthetic-PK
// derivation, filter scoring, and dow-staggering stay in their crons; this
// module owns only the I/O. See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';
import { supabase } from '../services/supabase.js';
import type { FilterResult } from '../services/screener/universeFilter.js';

/** A universe row in the shape the readers consume (camelCase). The selects
 *  all pull the same column set, so every reader gets a uniform row regardless
 *  of which fields it actually uses. `conid` is the synthetic PK; `realConid`
 *  is the IB-resolved conid (null until conidResolutionProducer stamps it). */
export interface UniverseRow {
  conid: number;
  symbol: string;
  mic: string | null;
  realConid: number | null;
  lastPrice: number | null;
  lastVolume: number | null;
  lastAvgVolume: number | null;
}

/** A fully-scored row as the nightly universeCron sweep produces it (camelCase;
 *  the module maps to columns). */
export interface ScoredUniverseRow {
  conid: number;
  symbol: string;
  type: string | null;
  mic: string | null;
  filterResult: FilterResult;
  lastPrice: number | null;
  lastMarketCapM: number | null;
  lastAvgVolume: number | null;
  lastFilterPass: string; // ISO
  computedAt: string; // ISO
}

const READ_COLS = 'conid, symbol, mic, real_conid, last_price, last_volume, last_avg_volume';
const PAGE = 1000;
const READ_CHUNK = 900;
const WRITE_CHUNK = 500;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

interface RawUniverseRow {
  conid: unknown;
  symbol: unknown;
  mic: unknown;
  real_conid: unknown;
  last_price: unknown;
  last_volume: unknown;
  last_avg_volume: unknown;
}

function toRow(r: RawUniverseRow): UniverseRow {
  return {
    conid: num(r.conid) ?? 0,
    symbol: String(r.symbol ?? ''),
    mic: r.mic == null ? null : String(r.mic),
    realConid: num(r.real_conid),
    lastPrice: num(r.last_price),
    lastVolume: num(r.last_volume),
    lastAvgVolume: num(r.last_avg_volume),
  };
}

class UniverseTableModule extends TableModule {
  constructor() {
    super('universe');
  }

  // --- writers (six producers, one owner) ----------------------------------

  /** Upsert scored sweep rows on the synthetic-`conid` PK, chunked. The nightly
   *  universeCron is the sole bulk writer; it streams batches through here. */
  async upsertScored(rows: ScoredUniverseRow[]): Promise<void> {
    if (rows.length === 0) return;
    const mapped = rows.map((r) => ({
      conid: r.conid,
      symbol: r.symbol,
      type: r.type,
      mic: r.mic,
      filter_result: r.filterResult,
      last_price: r.lastPrice,
      last_market_cap_m: r.lastMarketCapM,
      last_avg_volume: r.lastAvgVolume,
      last_filter_pass: r.lastFilterPass,
      computed_at: r.computedAt,
    }));
    for (let i = 0; i < mapped.length; i += WRITE_CHUNK) {
      await this.run('upsertScored', this.from().upsert(mapped.slice(i, i + WRITE_CHUNK), { onConflict: 'conid' }));
    }
  }

  /** Retention — drop rows not seen in a sweep since `cutoffIso`; returns the
   *  deleted count (universeCron logs it). */
  async purgeStaleBefore(cutoffIso: string): Promise<number> {
    return this.runCount(
      'purgeStaleBefore',
      this.from().delete({ count: 'exact' }).lt('last_filter_pass', cutoffIso),
    );
  }

  /** Stamp the IB-resolved real_conid onto a synthetic-PK row (conid worker). */
  async setRealConid(conid: number, realConid: number): Promise<void> {
    await this.run('setRealConid', this.from().update({ real_conid: realConid }).eq('conid', conid));
  }

  /** Refresh market cap + computed_at for a synthetic-PK row (weekly cap pass). */
  async setMarketCap(conid: number, marketCapM: number, computedAtIso: string): Promise<void> {
    await this.run(
      'setMarketCap',
      this.from().update({ last_market_cap_m: marketCapM, computed_at: computedAtIso }).eq('conid', conid),
    );
  }

  /** Refresh the daily quote (price/volume + computed_at) for all rows of a
   *  symbol (the Polygon/Yahoo daily producer writes by symbol). */
  async setDailyQuoteBySymbol(
    symbol: string,
    lastPrice: number,
    lastVolume: number,
    computedAtIso: string,
  ): Promise<void> {
    await this.run(
      'setDailyQuoteBySymbol',
      this.from()
        .update({ last_price: lastPrice, last_volume: lastVolume, computed_at: computedAtIso })
        .eq('symbol', symbol),
    );
  }

  /** Mark an IB-resolved row auto_promoted (catalyst carryover surfacing). */
  async markAutoPromoted(realConid: number): Promise<void> {
    await this.run('markAutoPromoted', this.from().update({ auto_promoted: true }).eq('real_conid', realConid));
  }

  /** Recompute last_avg_volume (30d median) across the universe in one SQL
   *  statement — the daily-bars producer calls this after writing bars. */
  async refreshAvgVolume(): Promise<void> {
    const { error } = await supabase().rpc('refresh_universe_avg_volume');
    if (error) throw new Error(`universe.refreshAvgVolume: ${error.message}`);
  }

  // --- readers -------------------------------------------------------------

  /** Ring-1 IN rows still awaiting conid resolution (real_conid IS NULL) —
   *  the conid-resolution producer's work queue. */
  async getUnresolvedInRows(limit: number): Promise<UniverseRow[]> {
    const rows = await this.run<RawUniverseRow[]>(
      'getUnresolvedInRows',
      this.from().select(READ_COLS).eq('filter_result', 'in').is('real_conid', null).limit(limit),
    );
    return (rows ?? []).map(toRow);
  }

  /** Every Ring-1 IN row (resolved or not), paginated to the whole set. Used by
   *  the weekly cap refresh (by conid) and the daily quote producer (by symbol). */
  async getInRows(): Promise<UniverseRow[]> {
    return this.paginateInRows(false);
  }

  /** Ring-1 IN rows with a resolved real_conid, paginated to the whole set.
   *  Used by the intraday-stats stagger + the intraday-range-trader join. */
  async getResolvedInRows(): Promise<UniverseRow[]> {
    return this.paginateInRows(true);
  }

  private async paginateInRows(resolvedOnly: boolean): Promise<UniverseRow[]> {
    const out: UniverseRow[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = this.from().select(READ_COLS).eq('filter_result', 'in');
      if (resolvedOnly) q = q.not('real_conid', 'is', null);
      const rows = await this.run<RawUniverseRow[]>('getInRows', q.range(from, from + PAGE - 1));
      const batch = rows ?? [];
      out.push(...batch.map(toRow));
      if (batch.length < PAGE) break;
    }
    return out;
  }

  /** IN + resolved rows for a set of symbols (chunked) — the event producers'
   *  earnings-symbol → universe join (catalyst candidates, post-earnings drift). */
  async getResolvedInRowsBySymbols(symbols: string[]): Promise<UniverseRow[]> {
    const out: UniverseRow[] = [];
    for (let i = 0; i < symbols.length; i += READ_CHUNK) {
      const rows = await this.run<RawUniverseRow[]>(
        'getResolvedInRowsBySymbols',
        this.from()
          .select(READ_COLS)
          .eq('filter_result', 'in')
          .not('real_conid', 'is', null)
          .in('symbol', symbols.slice(i, i + READ_CHUNK)),
      );
      out.push(...(rows ?? []).map(toRow));
    }
    return out;
  }

  /** Auto-promoted rows with a resolved real_conid — catalyst's carryover set. */
  async getAutoPromotedResolved(limit: number): Promise<UniverseRow[]> {
    const rows = await this.run<RawUniverseRow[]>(
      'getAutoPromotedResolved',
      this.from().select(READ_COLS).eq('auto_promoted', true).not('real_conid', 'is', null).limit(limit),
    );
    return (rows ?? []).map(toRow);
  }

  /** Rows for a set of real_conids (chunked) — the curated/universe price-seed
   *  joins (quotes.seedDailyQuotes, dipBounce.computeSet). */
  async getByRealConids(realConids: number[]): Promise<UniverseRow[]> {
    const out: UniverseRow[] = [];
    for (let i = 0; i < realConids.length; i += READ_CHUNK) {
      const rows = await this.run<RawUniverseRow[]>(
        'getByRealConids',
        this.from().select(READ_COLS).in('real_conid', realConids.slice(i, i + READ_CHUNK)),
      );
      out.push(...(rows ?? []).map(toRow));
    }
    return out;
  }
}

export const universeTableModule = new UniverseTableModule();
