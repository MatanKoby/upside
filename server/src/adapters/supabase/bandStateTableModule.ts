// TableModule for `band_state` — the SOLE server-side gatekeeper for that
// table. Writer: bandEngineCron (per-(conid,session_date) upsert). Readers:
// bandEngineCron (reads its own prior state, then reconstructs the walk-state
// machine from it) and dipBounceCron.loadBands (a minimal regime slice). The
// client reads band_state directly via Supabase (the walking-band chip); this
// module governs server-side I/O.
//
// Batch ARCH-3 (rollout slice 5). The module owns only the persisted shape —
// the band-engine walk-state reconstruction (replaying anchors against the
// latest bar) is business logic and stays in the cron. `anchors` and
// band_touch_last_fired_at are jsonb passthrough, typed loosely here so the
// module stays decoupled from the band-engine domain types. No behavior change.
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

/** Fields persisted to a band_state row (writer input). `updated_at` is
 *  stamped by the module. */
export interface BandStateWrite {
  conid: number;
  sessionDate: string;
  anchors: unknown[];
  currentLowBand: number | null;
  currentHighBand: number | null;
  sessionRegime: string | null;
  volScalar: number | null;
  volRegimeShift: boolean;
  bandTouchLastFiredAt: Record<string, string | null>;
}

/** A band_state row read back (the persisted shape — no walk state). */
export interface BandStateRecord extends BandStateWrite {
  updatedAt: string;
}

/** Minimal (regime, vol-shift) slice — the dip-bounce reader. */
export interface BandRegime {
  conid: number;
  sessionRegime: string | null;
  volRegimeShift: boolean | null;
}

interface BandStateDbRow {
  conid: number | string;
  session_date: string;
  anchors: unknown[] | null;
  current_low_band: number | string | null;
  current_high_band: number | string | null;
  session_regime: string | null;
  vol_scalar: number | string | null;
  vol_regime_shift: boolean | null;
  band_touch_last_fired_at: Record<string, string | null> | null;
  updated_at: string;
}

const READ_CHUNK = 900;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class BandStateTableModule extends TableModule {
  constructor() {
    super('band_state');
  }

  // --- writer (bandEngineCron, sole owner) ---------------------------------

  /** Upsert one (conid,session_date) band-state row. Stamps `updated_at`. */
  async upsert(s: BandStateWrite): Promise<void> {
    await this.run(
      'upsert',
      this.from().upsert(
        {
          conid: s.conid,
          session_date: s.sessionDate,
          anchors: s.anchors,
          current_low_band: s.currentLowBand,
          current_high_band: s.currentHighBand,
          session_regime: s.sessionRegime,
          vol_scalar: s.volScalar,
          vol_regime_shift: s.volRegimeShift,
          band_touch_last_fired_at: s.bandTouchLastFiredAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conid,session_date' },
      ),
    );
  }

  // --- readers -------------------------------------------------------------

  /** Full persisted rows for a set of conids on `sessionDate` — the engine's
   *  own-state reader (it reconstructs the walk machine from these). Chunked. */
  async getBySessionDate(conids: number[], sessionDate: string): Promise<BandStateRecord[]> {
    const out: BandStateRecord[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<BandStateDbRow[]>(
        'getBySessionDate',
        this.from().select('*').eq('session_date', sessionDate).in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        out.push({
          conid: Number(r.conid),
          sessionDate: r.session_date,
          anchors: (r.anchors ?? []) as unknown[],
          currentLowBand: num(r.current_low_band),
          currentHighBand: num(r.current_high_band),
          sessionRegime: r.session_regime ?? null,
          volScalar: num(r.vol_scalar),
          volRegimeShift: !!r.vol_regime_shift,
          bandTouchLastFiredAt: r.band_touch_last_fired_at ?? {},
          updatedAt: r.updated_at,
        });
      }
    }
    return out;
  }

  /** Minimal (regime, vol-shift) slice for a set of conids — the dip-bounce
   *  reader. Chunked. Preserves a null vol_regime_shift. */
  async getRegimes(conids: number[], sessionDate: string): Promise<BandRegime[]> {
    const out: BandRegime[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: number | string; session_regime: string | null; vol_regime_shift: boolean | null }>>(
        'getRegimes',
        this.from()
          .select('conid, session_regime, vol_regime_shift')
          .eq('session_date', sessionDate)
          .in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      for (const r of rows ?? []) {
        out.push({ conid: Number(r.conid), sessionRegime: r.session_regime ?? null, volRegimeShift: r.vol_regime_shift ?? null });
      }
    }
    return out;
  }
}

export const bandStateTableModule = new BandStateTableModule();
