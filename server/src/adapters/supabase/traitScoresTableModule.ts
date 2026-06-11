// TableModule for `trait_scores` — the SOLE server-side gatekeeper for that
// table, and the **3-writer showcase** for the pattern. THREE producers write
// it, but all share one owner here:
//   - intradayRangeTraderProducer → trait 'intraday_range_trader' (batch upsert)
//   - catalystReversalProducer    → trait 'catalyst_reversal'
//   - postEarningsDriftProducer   → trait 'post_earnings_drift'
// plus retention (traitScoresRetention) and readers (curatedListCron + the
// curatedList/asof resolver). The client reads trait_scores directly via
// Supabase; this module governs server-side I/O.
//
// Batch ARCH-2 — proves the one-writer-OWNER rule under multiple producers:
// many crons write the table, yet the row shape, the (conid,trait,asof_date)
// conflict key, and the first-fire latch all live in ONE place behind named
// methods. See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

/** The three screener traits scored into trait_scores. */
export type TraitKind =
  | 'intraday_range_trader'
  | 'catalyst_reversal'
  | 'post_earnings_drift';

/** One trait score (domain, camelCase). `computed_at` is stamped by the module. */
export interface TraitScore {
  conid: number;
  trait: TraitKind;
  asofDate: string; // 'YYYY-MM-DD'
  score: number;
  payload: unknown; // jsonb — trait-specific, owned by the scorer
}

const UPSERT_CHUNK = 500; // PostgREST batch ceiling for the bulk intraday write

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

class TraitScoresTableModule extends TableModule {
  constructor() {
    super('trait_scores');
  }

  // --- writers (3 producers, one owner) ------------------------------------

  /** Upsert trait-score rows on the (conid,trait,asof_date) PK, chunked. All
   *  three producers write through here — `intraday` a full batch, `catalyst`
   *  / `post_earnings` one row each. No-op on an empty array. */
  async upsertScores(scores: TraitScore[]): Promise<void> {
    if (scores.length === 0) return;
    const computedAt = new Date().toISOString();
    const rows = scores.map((s) => ({
      conid: s.conid,
      trait: s.trait,
      asof_date: s.asofDate,
      score: s.score,
      payload: s.payload,
      computed_at: computedAt,
    }));
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      await this.run(
        'upsertScores',
        this.from().upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'conid,trait,asof_date' }),
      );
    }
  }

  /** First-fire latch: atomically stamp `last_fired_at` iff it's still null.
   *  Returns true when THIS call set it (so the caller pings once), false on
   *  idempotent re-runs. */
  async stampFirstFire(conid: number, trait: TraitKind, asofDate: string): Promise<boolean> {
    const stamped = await this.run<Array<{ conid: number }>>(
      'stampFirstFire',
      this.from()
        .update({ last_fired_at: new Date().toISOString() })
        .eq('conid', conid)
        .eq('trait', trait)
        .eq('asof_date', asofDate)
        .is('last_fired_at', null)
        .select('conid'),
    );
    return (stamped?.length ?? 0) > 0;
  }

  // --- retention -----------------------------------------------------------

  /** Drop one trait's rows older than `cutoff` (YYYY-MM-DD); returns the
   *  deleted count. The per-trait shelf-life policy stays in the cron. */
  async purgeOlderThan(trait: TraitKind, cutoff: string): Promise<number> {
    return this.runCount(
      'purgeOlderThan',
      this.from().delete({ count: 'exact' }).eq('trait', trait).lt('asof_date', cutoff),
    );
  }

  // --- readers -------------------------------------------------------------

  /** (conid, score) for one trait on a date — the curated-list seed reader. */
  async getScoresByTrait(trait: TraitKind, asofDate: string): Promise<Array<{ conid: number; score: number }>> {
    const rows = await this.run<Array<{ conid: unknown; score: unknown }>>(
      'getScoresByTrait',
      this.from().select('conid, score').eq('trait', trait).eq('asof_date', asofDate),
    );
    return (rows ?? []).map((r) => ({ conid: toNum(r.conid), score: toNum(r.score) }));
  }

  /** The latest `asof_date` present, optionally constrained to one trait or a
   *  set of traits. Null when no matching rows exist. */
  async latestAsof(trait?: TraitKind | readonly TraitKind[]): Promise<string | null> {
    let q = this.from().select('asof_date').order('asof_date', { ascending: false }).limit(1);
    if (typeof trait === 'string') q = q.eq('trait', trait);
    else if (trait && trait.length) q = q.in('trait', trait as unknown as string[]);
    const rows = await this.run<Array<{ asof_date: string }>>('latestAsof', q);
    return rows?.[0]?.asof_date ?? null;
  }

  /** Conids scored for any of `traits` on `asofDate` — the event-trait union. */
  async getConidsByTraits(traits: readonly TraitKind[], asofDate: string): Promise<number[]> {
    const rows = await this.run<Array<{ conid: unknown }>>(
      'getConidsByTraits',
      this.from().select('conid').eq('asof_date', asofDate).in('trait', traits as unknown as string[]),
    );
    return (rows ?? []).map((r) => toNum(r.conid));
  }
}

export const traitScoresTableModule = new TraitScoresTableModule();
