// TableModule for `intraday_stats` — the SOLE server-side gatekeeper for that
// table. Writer: intradayStatsCron (per-conid upsert of the computed
// distribution). Readers: bandEngineCron (p50 baseline), dipBounceCron (p50/p75
// band), intradayRangeTraderProducer (p50/p75 + sample_size), and
// intradayStatsAlerts (single-conid p50/p75 + the last_fired_at latch).
//
// Batch ARCH-3 (rollout slice 6). One writer-owner; the four readers each take
// the slice they need behind named methods. No behavior change.
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';
import type { IntradayStats } from '../services/intradayStats.js';

/** The percentile slice the bulk readers need (camelCase). */
export interface IntradayPercentiles {
  conid: number;
  p50: number | null;
  p75: number | null;
  sampleSize: number;
}

/** The single-conid alert slice (adds the cooldown latch). */
export interface IntradayAlertStats {
  p50: number | null;
  p75: number | null;
  lastFiredAt: string | null;
}

const READ_CHUNK = 900;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class IntradayStatsTableModule extends TableModule {
  constructor() {
    super('intraday_stats');
  }

  // --- writer (intradayStatsCron, sole owner) ------------------------------

  /** Upsert one conid's computed distribution. Stamps `computed_at`. */
  async upsert(conid: number, symbol: string, stats: IntradayStats): Promise<void> {
    await this.run(
      'upsert',
      this.from().upsert({ conid, symbol, ...stats, computed_at: new Date().toISOString() }, { onConflict: 'conid' }),
    );
  }

  // --- readers -------------------------------------------------------------

  /** Percentile slice for a set of conids — the bulk readers. Chunked. */
  async getByConids(conids: number[]): Promise<IntradayPercentiles[]> {
    const out: IntradayPercentiles[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: number | string; intraday_low_pct_p50: number | string | null; intraday_low_pct_p75: number | string | null; sample_size: number | string | null }>>(
        'getByConids',
        this.from().select('conid, intraday_low_pct_p50, intraday_low_pct_p75, sample_size').in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        out.push({ conid: Number(r.conid), p50: num(r.intraday_low_pct_p50), p75: num(r.intraday_low_pct_p75), sampleSize: num(r.sample_size) ?? 0 });
      }
    }
    return out;
  }

  /** Single conid's p50/p75 + last_fired_at — the alert reader. Null when absent. */
  async getByConid(conid: number): Promise<IntradayAlertStats | null> {
    const row = await this.run<{ intraday_low_pct_p50: number | string | null; intraday_low_pct_p75: number | string | null; last_fired_at: string | null } | null>(
      'getByConid',
      this.from().select('conid, intraday_low_pct_p50, intraday_low_pct_p75, last_fired_at').eq('conid', conid).maybeSingle(),
    );
    if (!row) return null;
    return { p50: num(row.intraday_low_pct_p50), p75: num(row.intraday_low_pct_p75), lastFiredAt: row.last_fired_at ?? null };
  }

  /** Stamp `last_fired_at = now` for one conid (the alert cooldown latch). */
  async stampFired(conid: number): Promise<void> {
    await this.run('stampFired', this.from().update({ last_fired_at: new Date().toISOString() }).eq('conid', conid));
  }
}

export const intradayStatsTableModule = new IntradayStatsTableModule();
