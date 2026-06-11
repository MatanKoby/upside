// TableModule for `daily_bars` — the SOLE server-side gatekeeper for that table
// (the Polygon-primary daily-grain SSOT, Batch X4). Writer: universeQuoteProducer
// (Polygon batch upsert + Yahoo gap-fill + retention + a date-coverage count).
// Readers: dailyBars.loadDailyBars (the daily-grain consumers) and
// quotes.seedDailyQuotes (latest date + recent closes for sparklines).
//
// Batch ARCH-3 (rollout slice 7). One writer-owner; readers take named slices.
// The pure bar helpers (recentWeekdays / buildDailyBarRows) + the DailyBar /
// DailyBarRow domain types stay in services/dailyBars.ts; this module owns only
// the I/O. No behavior change. See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';
import type { DailyBarRow } from '../../services/dailyBars.js';

/** The OHLCV columns of a daily bar (no derived `t` — the service adds it). */
export interface DailyBarOhlcv {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** A (conid, date, close) tuple — the sparkline source. */
export interface DailyClose {
  conid: number;
  date: string;
  c: number;
}

const READ_CHUNK = 900;
const WRITE_CHUNK = 1000;

function fin(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class DailyBarsTableModule extends TableModule {
  constructor() {
    super('daily_bars');
  }

  // --- writer (universeQuoteProducer, sole owner) --------------------------

  /** Upsert built daily-bar rows on the (conid,date) PK, chunked. Rows are
   *  already shaped + sourced by buildDailyBarRows. No-op on an empty array. */
  async upsertBars(rows: DailyBarRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await this.run('upsertBars', this.from().upsert(rows.slice(i, i + WRITE_CHUNK), { onConflict: 'conid,date' }));
    }
  }

  /** Retention — drop rows older than `cutoff` (YYYY-MM-DD). */
  async purgeOlderThan(cutoff: string): Promise<void> {
    await this.deleteOlderThan('date', cutoff);
  }

  /** How many rows daily_bars holds for a trading date (coverage probe). */
  async countForDate(date: string): Promise<number> {
    return this.runCount('countForDate', this.from().select('conid', { count: 'exact', head: true }).eq('date', date));
  }

  // --- readers -------------------------------------------------------------

  /** A conid's most-recent `lookbackDays` bars, oldest→newest (matches the
   *  RawIbHistory order the consumers expect). */
  async getBars(conid: number, lookbackDays: number): Promise<DailyBarOhlcv[]> {
    const rows = await this.run<Array<{ date: string; o: unknown; h: unknown; l: unknown; c: unknown; v: unknown }>>(
      'getBars',
      this.from().select('date, o, h, l, c, v').eq('conid', conid).order('date', { ascending: false }).limit(lookbackDays),
    );
    // Came newest-first (so the limit takes the most recent N); flip to oldest-first.
    return [...(rows ?? [])]
      .reverse()
      .map((r) => ({ date: r.date, o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
  }

  /** The latest bar date present across the table, or null when empty. */
  async latestDate(): Promise<string | null> {
    const rows = await this.run<Array<{ date: string }>>(
      'latestDate',
      this.from().select('date').order('date', { ascending: false }).limit(1),
    );
    return rows?.[0]?.date ?? null;
  }

  /** (conid, date, close) rows for a set of conids on/after `cutoff`, each
   *  chunk date-ascending — the sparkline source. Chunked; non-finite dropped. */
  async getClosesSince(conids: number[], cutoff: string): Promise<DailyClose[]> {
    const out: DailyClose[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: unknown; date: string; c: unknown }>>(
        'getClosesSince',
        this.from().select('conid, date, c').in('conid', conids.slice(i, i + READ_CHUNK)).gte('date', cutoff).order('date', { ascending: true }),
      );
      for (const r of rows ?? []) {
        const conid = fin(r.conid);
        const c = fin(r.c);
        if (conid == null || c == null) continue;
        out.push({ conid, date: r.date, c });
      }
    }
    return out;
  }
}

export const dailyBarsTableModule = new DailyBarsTableModule();
