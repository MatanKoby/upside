// TableModule for `signals` — the SOLE server-side gatekeeper for persisted
// analysis signals. Sole writer: signalEngine.persistAnalysis (supersede prior
// rows for the (user, symbol), then insert the one new signal — or a no_signal
// row when the playbook is null). The FE reads `signals` directly via Supabase.
//
// The module owns I/O + snake↔camel mapping; signal-shaping (legs → price
// range, playbook payload, no_signal fallback) stays in the engine. Optional
// fields are written only when provided, so a no_signal row omits the
// price/playbook columns exactly as before.
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

export interface SignalInsert {
  userId: string;
  symbol: string;
  conid: number | null;
  analysisId: string;
  signalType: string; // direction ('buy'|'sell') or 'no_signal'
  signalQuality: number;
  priceRangeLow?: number | null;
  priceRangeHigh?: number | null;
  optimalPrice?: number | null;
  motivation?: string | null;
  rationale?: string | null;
  playbook?: Record<string, unknown> | null;
  analyzedAt: string;
  expiresAt: string;
}

class SignalsTableModule extends TableModule {
  constructor() {
    super('signals');
  }

  /** Point every prior non-superseded signal for (user, symbol) at the new
   *  analysis. Runs before the insert so the new row can't supersede itself. */
  async supersedePriorForSymbol(userId: string, symbol: string, analysisId: string): Promise<void> {
    await this.run(
      'supersedePriorForSymbol',
      this.from()
        .update({ superseded_by_analysis_id: analysisId })
        .eq('user_id', userId)
        .eq('symbol', symbol)
        .is('superseded_by_analysis_id', null),
    );
  }

  /** Insert one signal row. Optional columns are emitted only when supplied
   *  (a no_signal insert omits the price-range/playbook columns). */
  async insertSignal(s: SignalInsert): Promise<void> {
    const row: Record<string, unknown> = {
      user_id: s.userId,
      symbol: s.symbol,
      conid: s.conid,
      analysis_id: s.analysisId,
      signal_type: s.signalType,
      signal_quality: s.signalQuality,
      analyzed_at: s.analyzedAt,
      expires_at: s.expiresAt,
    };
    if (s.priceRangeLow !== undefined) row.price_range_low = s.priceRangeLow;
    if (s.priceRangeHigh !== undefined) row.price_range_high = s.priceRangeHigh;
    if (s.optimalPrice !== undefined) row.optimal_price = s.optimalPrice;
    if (s.motivation !== undefined) row.motivation = s.motivation;
    if (s.rationale !== undefined) row.rationale = s.rationale;
    if (s.playbook !== undefined) row.playbook = s.playbook;
    await this.run('insertSignal', this.from().insert(row));
  }
}

export const signalsTableModule = new SignalsTableModule();
