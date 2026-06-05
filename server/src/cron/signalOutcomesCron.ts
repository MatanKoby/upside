// signalOutcomesCron — Batch X1.
//
// Every 5 minutes, fills the +30m / +2h / +1d / +3d outcome snapshot for each
// `signal_fires` row whose offset has elapsed and isn't yet recorded. Snapshot
// price = the canonical quote at cron time; return_pct vs price_at_fire. Generic
// across signal kinds — band-touch + marker fires plug into the same backbone
// once ported. Feeds the signal_hit_rate_30d view. Spec:
// spec/signals/dip-bounce-scorer.md → Forward-tracking.

import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';
import { OUTCOME_OFFSETS } from '../config/dipBounceScorer.js';

const CADENCE_MS = 5 * 60_000;
const FIRST_RUN_DELAY_MS = 120_000;
const LONGEST_MS = 3 * 24 * 3600 * 1000; // +3d
const CHUNK = 900;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

interface FireRow { id: string; conid: number; priceAtFire: number | null; fireMs: number }

async function loadRecentFires(): Promise<FireRow[]> {
  // A small buffer past +3d so a fire's last offset is still pickable on the
  // tick right after it elapses.
  const since = new Date(Date.now() - LONGEST_MS - 6 * 3600 * 1000).toISOString();
  const { data, error } = await supabase()
    .from('signal_fires')
    .select('id, conid, price_at_fire, fire_ts')
    .gte('fire_ts', since);
  if (error) {
    void notifyError('signalOutcomesCron.loadFires', error.message);
    return [];
  }
  return (data ?? []).map((r) => ({
    id: String((r as { id: unknown }).id),
    conid: num((r as { conid: unknown }).conid) ?? 0,
    priceAtFire: num((r as { price_at_fire: unknown }).price_at_fire),
    fireMs: new Date((r as { fire_ts: string }).fire_ts).getTime(),
  }));
}

async function loadExistingOutcomes(fireIds: string[]): Promise<Set<string>> {
  const out = new Set<string>(); // `${fireId}:${offset}`
  for (let i = 0; i < fireIds.length; i += CHUNK) {
    const { data } = await supabase()
      .from('signal_outcomes')
      .select('fire_id, t_offset')
      .in('fire_id', fireIds.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      out.add(`${(r as { fire_id: string }).fire_id}:${(r as { t_offset: string }).t_offset}`);
    }
  }
  return out;
}

async function loadPrices(conids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const uniq = [...new Set(conids)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data } = await supabase()
      .from('quotes')
      .select('conid, canonical_price')
      .in('conid', uniq.slice(i, i + CHUNK));
    for (const r of data ?? []) {
      const c = num((r as { conid: unknown }).conid);
      const p = num((r as { canonical_price: unknown }).canonical_price);
      if (c != null && p != null) out.set(c, p);
    }
  }
  return out;
}

async function tick(): Promise<void> {
  const fires = await loadRecentFires();
  if (fires.length === 0) return;
  const existing = await loadExistingOutcomes(fires.map((f) => f.id));
  const now = Date.now();

  // Which (fire, offset) pairs are due + unrecorded?
  interface Due { fire: FireRow; offset: string }
  const due: Due[] = [];
  for (const fire of fires) {
    for (const off of OUTCOME_OFFSETS) {
      if (now < fire.fireMs + off.ms) continue; // not elapsed yet
      if (existing.has(`${fire.id}:${off.label}`)) continue;
      due.push({ fire, offset: off.label });
    }
  }
  if (due.length === 0) return;

  const prices = await loadPrices(due.map((d) => d.fire.conid));
  const rows: Array<Record<string, unknown>> = [];
  for (const d of due) {
    const price = prices.get(d.fire.conid);
    if (price == null) continue; // no quote → try again next tick
    const returnPct =
      d.fire.priceAtFire != null && d.fire.priceAtFire > 0
        ? ((price - d.fire.priceAtFire) / d.fire.priceAtFire) * 100
        : null;
    rows.push({
      fire_id: d.fire.id,
      t_offset: d.offset,
      snapshot_ts: new Date(now).toISOString(),
      price,
      return_pct: returnPct,
    });
  }
  if (rows.length === 0) return;

  const { error } = await supabase()
    .from('signal_outcomes')
    .upsert(rows, { onConflict: 'fire_id,t_offset' });
  if (error) {
    void notifyError('signalOutcomesCron.write', error.message);
    return;
  }
  console.log(`[signalOutcomesCron] wrote ${rows.length} outcome snapshots`);
}

export function startSignalOutcomesCron(): void {
  console.log('[signalOutcomesCron] starting, 5-min cadence');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('signalOutcomesCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}
