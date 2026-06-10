// TableModule for `entry_zones` — the SOLE server-side gatekeeper for that
// table. Writer: entryZonesCron (per-(conid,horizon) upsert + wipe). Readers:
// entryZoneAlerts (zones for one conid + the last_fired_at latch) and
// dipBounceCron.loadZones (bulk zones for the compute set). The client reads
// entry_zones directly via Supabase Realtime (the FE chips); this module
// governs server-side I/O.
//
// Batch ARCH-3 (rollout slice 4). One writer-owner: the upsert, the no-candidate
// wipe, and the alert latch all live here behind named methods. No behavior
// change. See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

export type EntryHorizon = 'intraday' | 'overnight' | 'multiday';

/** A computed entry zone to persist (writer input). */
export interface EntryZoneWrite {
  conid: number;
  horizon: EntryHorizon;
  price: number;
  reasoning: string;
  confidence: number;
  trendRegime: string;
  overboughtTightened: boolean;
}

/** An entry-zone row read back (domain, camelCase). Rows with a non-finite
 *  price are dropped — both readers already skip those. */
export interface EntryZoneRecord {
  conid: number;
  horizon: EntryHorizon;
  price: number;
  reasoning: string;
  confidence: number;
  trendRegime: string | null;
  lastFiredAt: string | null;
}

interface EntryZoneRow {
  conid: unknown;
  horizon: string;
  price: unknown;
  reasoning: string | null;
  confidence: unknown;
  trend_regime: string | null;
  last_fired_at: string | null;
}

const READ_CHUNK = 900;
const READ_COLS = 'conid, horizon, price, reasoning, confidence, trend_regime, last_fired_at';

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function mapRows(rows: EntryZoneRow[] | null): EntryZoneRecord[] {
  return (rows ?? []).flatMap((r) => {
    const price = toNum(r.price);
    if (!Number.isFinite(price)) return []; // a zone with no valid price is noise to both readers
    return [{
      conid: toNum(r.conid),
      horizon: r.horizon as EntryHorizon,
      price,
      reasoning: r.reasoning ?? '',
      confidence: toNum(r.confidence),
      trendRegime: r.trend_regime ?? null,
      lastFiredAt: r.last_fired_at ?? null,
    }];
  });
}

class EntryZonesTableModule extends TableModule {
  constructor() {
    super('entry_zones');
  }

  // --- writer (entryZonesCron, sole owner) ---------------------------------

  /** Upsert one (conid,horizon) zone. Stamps `computed_at`. */
  async upsert(z: EntryZoneWrite): Promise<void> {
    await this.run(
      'upsert',
      this.from().upsert(
        {
          conid: z.conid,
          horizon: z.horizon,
          price: z.price,
          reasoning: z.reasoning,
          confidence: z.confidence,
          trend_regime: z.trendRegime,
          overbought_tightened: z.overboughtTightened,
          computed_at: new Date().toISOString(),
        },
        { onConflict: 'conid,horizon' },
      ),
    );
  }

  /** Wipe a single (conid,horizon) zone — no candidate within reach this pass. */
  async deleteZone(conid: number, horizon: EntryHorizon): Promise<void> {
    await this.run('deleteZone', this.from().delete().eq('conid', conid).eq('horizon', horizon));
  }

  /** Stamp `last_fired_at = now` on the given horizons of one conid (the alert
   *  cooldown latch — every horizon in a fired cluster gets stamped). No-op on
   *  an empty list. */
  async stampFired(conid: number, horizons: EntryHorizon[]): Promise<void> {
    if (horizons.length === 0) return;
    await this.run(
      'stampFired',
      this.from().update({ last_fired_at: new Date().toISOString() }).eq('conid', conid).in('horizon', horizons),
    );
  }

  // --- readers -------------------------------------------------------------

  /** All zones for one conid — the alert candidate reader. */
  async getByConid(conid: number): Promise<EntryZoneRecord[]> {
    const rows = await this.run<EntryZoneRow[]>('getByConid', this.from().select(READ_COLS).eq('conid', conid));
    return mapRows(rows);
  }

  /** Zones for a set of conids — the dip-bounce bulk reader (chunked). */
  async getByConids(conids: number[]): Promise<EntryZoneRecord[]> {
    const out: EntryZoneRecord[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<EntryZoneRow[]>(
        'getByConids',
        this.from().select(READ_COLS).in('conid', conids.slice(i, i + READ_CHUNK)),
      );
      out.push(...mapRows(rows));
    }
    return out;
  }
}

export const entryZonesTableModule = new EntryZonesTableModule();
