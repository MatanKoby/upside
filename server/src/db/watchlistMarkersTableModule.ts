// TableModule for `watchlist_markers` — the SOLE server-side gatekeeper for the
// per-(user, conid) price markers (spec/screens/watchlist.md → markers). The
// CRUD route owns create/update/delete + the ownership probe; the per-quote
// price check (markers.ts) reads enabled markers and stamps last_fired_at.
//
// Batch ARCH-3 (rollout slice 13 — the watchlist_* trio). The module owns the
// column names + snake↔camel mapping; the transition/cooldown gate stays in
// markers.ts and the payload validation stays in the route. CRUD writes return
// the raw row (snake_case) — that's the FE wire contract. Same SQL, no behavior
// change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

export type MarkerCondition = 'at_or_above' | 'at_or_below' | 'about';

/** An enabled marker as the per-quote price check reads it (camelCase). `price`
 *  is normalized (null when non-finite); `cooldownHours` is raw `Number(...)`
 *  so a missing value yields NaN exactly as before (cooldown never passes). */
export interface MarkerRow {
  id: string;
  userId: string;
  conid: number;
  label: string | null;
  price: number | null;
  condition: MarkerCondition;
  enabled: boolean;
  cooldownHours: number;
  lastFiredAt: string | null;
}

/** A new marker as the CRUD route creates it (the validated payload). */
export interface NewMarker {
  conid: number;
  label: string | null;
  price: number;
  condition: MarkerCondition;
  cooldown_hours: number;
}

const CHECK_COLS = 'id, user_id, conid, label, price, condition, enabled, cooldown_hours, last_fired_at';
const CRUD_COLS = `${CHECK_COLS}, created_at`;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class WatchlistMarkersTableModule extends TableModule {
  constructor() {
    super('watchlist_markers');
  }

  // --- price-check path ----------------------------------------------------

  /** Enabled markers for a conid — the per-write transition check. */
  async getEnabledByConid(conid: number): Promise<MarkerRow[]> {
    const rows = await this.run<Array<Record<string, unknown>>>(
      'getEnabledByConid',
      this.from().select(CHECK_COLS).eq('conid', conid).eq('enabled', true),
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      conid: Number(r.conid),
      label: r.label == null ? null : String(r.label),
      price: num(r.price),
      condition: r.condition as MarkerCondition,
      enabled: Boolean(r.enabled),
      cooldownHours: Number(r.cooldown_hours),
      lastFiredAt: r.last_fired_at == null ? null : String(r.last_fired_at),
    }));
  }

  /** Stamp last_fired_at after a marker fires. */
  async stampFired(markerId: string, firedAtIso: string): Promise<void> {
    await this.run('stampFired', this.from().update({ last_fired_at: firedAtIso }).eq('id', markerId));
  }

  // --- CRUD path -----------------------------------------------------------

  /** Owner user_id of a marker — the CRUD ownership guard. */
  async getOwnerUserId(markerId: string): Promise<string | null> {
    const r = await this.run<{ user_id: unknown } | null>(
      'getOwnerUserId',
      this.from().select('user_id').eq('id', markerId).maybeSingle(),
    );
    return r?.user_id == null ? null : String(r.user_id);
  }

  /** Insert a marker (stamping the owner), returning the created row in its
   *  snake_case wire shape. */
  async insertMarker(row: NewMarker, userId: string): Promise<Record<string, unknown>> {
    const r = await this.run<Record<string, unknown> | null>(
      'insertMarker',
      this.from().insert({ ...row, user_id: userId }).select(CRUD_COLS).single(),
    );
    if (!r) throw new Error('watchlist_markers.insertMarker: no row returned');
    return r;
  }

  /** Apply a validated patch (snake_case columns the route assembled),
   *  returning the updated row. */
  async updateMarker(markerId: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.run<Record<string, unknown> | null>(
      'updateMarker',
      this.from().update(fields).eq('id', markerId).select(CRUD_COLS).single(),
    );
    if (!r) throw new Error('watchlist_markers.updateMarker: no row returned');
    return r;
  }

  /** Delete a marker by id. */
  async deleteMarker(markerId: string): Promise<void> {
    await this.run('deleteMarker', this.from().delete().eq('id', markerId));
  }
}

export const watchlistMarkersTableModule = new WatchlistMarkersTableModule();
