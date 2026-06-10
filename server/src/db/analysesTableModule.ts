// TableModule for `analyses` — the SOLE server-side gatekeeper for persisted
// Analyze runs (spec/signals/playbook.md). The /analyze route reads the most
// recent run for the re-analyze soft-block; signalEngine.persistAnalysis is the
// sole writer (one row per completed run, returning its analysis_id so the new
// signal row + the supersede sweep can reference it).
//
// Batch ARCH-3 (rollout slice 14 — the final pair, with analysis_locks). The
// module owns the column names + snake↔camel mapping; the expiry/horizon +
// supersede policy stays in signalEngine. `indicator_snapshot`/`reasoning` are
// jsonb payloads, kept opaque here. Same SQL, no behavior change.

import { TableModule } from './TableModule.js';

/** A completed analysis row as signalEngine persists it (camelCase). */
export interface AnalysisInsert {
  userId: string;
  symbol: string;
  conid: number | null;
  indicatorSnapshot: unknown;
  reasoning: unknown;
  analyzedAt: string;
  expiresAt: string;
}

class AnalysesTableModule extends TableModule {
  constructor() {
    super('analyses');
  }

  /** analyzed_at of the most recent run for (user, symbol) at/after `sinceIso`,
   *  or null when none — the re-analyze soft-block probe. */
  async getRecentAnalyzedAt(userId: string, symbol: string, sinceIso: string): Promise<string | null> {
    const r = await this.run<{ analyzed_at: unknown } | null>(
      'getRecentAnalyzedAt',
      this.from()
        .select('analyzed_at')
        .eq('user_id', userId)
        .eq('symbol', symbol)
        .gte('analyzed_at', sinceIso)
        .order('analyzed_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    return r?.analyzed_at == null ? null : String(r.analyzed_at);
  }

  /** Insert a completed analysis → its analysis_id. SOLE writer. */
  async insertAnalysis(a: AnalysisInsert): Promise<string> {
    const r = await this.run<{ analysis_id: unknown } | null>(
      'insertAnalysis',
      this.from()
        .insert({
          user_id: a.userId,
          symbol: a.symbol,
          conid: a.conid,
          indicator_snapshot: a.indicatorSnapshot,
          reasoning: a.reasoning,
          analyzed_at: a.analyzedAt,
          expires_at: a.expiresAt,
        })
        .select('analysis_id')
        .single(),
    );
    if (!r) throw new Error('analyses.insertAnalysis: no row returned');
    return String(r.analysis_id);
  }
}

export const analysesTableModule = new AnalysesTableModule();
