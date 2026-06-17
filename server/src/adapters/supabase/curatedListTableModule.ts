// TableModule for `curated_list` — the SOLE server-side gatekeeper for that
// table. Writer: curatedListCron (rebuilds the set for a date). Readers: the
// dip-bounce compute set (computeSet), newsSentimentCron, and the
// curatedList/asof latest-date resolver. The client reads curated_list directly
// via Supabase; this module governs server-side I/O.
//
// Batch ARCH-3 (rollout slice 3, after news_sentiment + trait_scores). Single
// writer-owner: every write — the daily upsert, the same-date prune, and
// retention — lives here behind named methods. No behavior change.
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

/** One curated-list membership row (domain, camelCase). `computed_at` is
 *  stamped by the module. Shape matches buildCuratedList's CuratedRow so the
 *  cron passes its output straight through. */
export interface CuratedListEntry {
  conid: number;
  rank: number;
  intradayRangeTraderScore: number;
  avgDailyVolume: number | null;
  dailyAtrPct: number | null;
}

const PRUNE_CHUNK = 900; // chunk the same-date prune delete (large IN lists)

function toConid(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

class CuratedListTableModule extends TableModule {
  constructor() {
    super('curated_list');
  }

  // --- writer (curatedListCron, sole owner) --------------------------------

  /** Replace the curated set for `asofDate`: upsert the new rows on the
   *  (conid,asof_date) PK, then prune that date's rows that fell out of the
   *  set. Stamps `computed_at`. The whole write semantics for the table live
   *  here; the cron just supplies the gated, ranked rows. */
  async replaceForDate(asofDate: string, rows: CuratedListEntry[]): Promise<void> {
    if (rows.length > 0) {
      const computedAt = new Date().toISOString();
      const payload = rows.map((r) => ({
        conid: r.conid,
        asof_date: asofDate,
        rank: r.rank,
        intraday_range_trader_score: r.intradayRangeTraderScore,
        // `avg_daily_volume` is bigint — coerce to whole shares here (sole writer)
        // so a fractional median ADV can never throw on upsert and abort the write.
        avg_daily_volume: r.avgDailyVolume == null ? null : Math.round(r.avgDailyVolume),
        daily_atr_pct: r.dailyAtrPct,
        computed_at: computedAt,
      }));
      await this.run('replaceForDate.upsert', this.from().upsert(payload, { onConflict: 'conid,asof_date' }));
    }
    // Drop this date's rows that are no longer in the set.
    const keep = new Set(rows.map((r) => r.conid));
    const existing = await this.run<Array<{ conid: unknown }>>(
      'replaceForDate.existing',
      this.from().select('conid').eq('asof_date', asofDate),
    );
    const stale = (existing ?? [])
      .map((r) => toConid(r.conid))
      .filter((c) => Number.isFinite(c) && !keep.has(c));
    for (let i = 0; i < stale.length; i += PRUNE_CHUNK) {
      await this.run(
        'replaceForDate.prune',
        this.from().delete().eq('asof_date', asofDate).in('conid', stale.slice(i, i + PRUNE_CHUNK)),
      );
    }
  }

  // --- retention -----------------------------------------------------------

  /** Drop rows older than `cutoff` (YYYY-MM-DD). The 7-day policy stays in the
   *  cron; the module just executes the delete. */
  async purgeOlderThan(cutoff: string): Promise<void> {
    await this.deleteOlderThan('asof_date', cutoff);
  }

  // --- readers -------------------------------------------------------------

  /** Conids in the curated set on `asofDate` — the compute-set / news readers. */
  async getConidsByDate(asofDate: string): Promise<number[]> {
    const rows = await this.run<Array<{ conid: unknown }>>(
      'getConidsByDate',
      this.from().select('conid').eq('asof_date', asofDate),
    );
    return (rows ?? []).map((r) => toConid(r.conid)).filter((c) => Number.isFinite(c));
  }

  /** The latest `asof_date` present, or null when the list has never built. */
  async latestAsof(): Promise<string | null> {
    const rows = await this.run<Array<{ asof_date: string }>>(
      'latestAsof',
      this.from().select('asof_date').order('asof_date', { ascending: false }).limit(1),
    );
    return rows?.[0]?.asof_date ?? null;
  }
}

export const curatedListTableModule = new CuratedListTableModule();
