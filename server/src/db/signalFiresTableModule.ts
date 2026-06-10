// TableModule for `signal_fires` — the SOLE server-side gatekeeper for screener
// signal-fire events (spec/signals/dip-bounce-scorer.md → Forward-tracking).
// dipBounceCron is the sole writer (one row per fire); two readers consume it:
// the cron's own 24h cooldown lookup and signalOutcomesCron's forward-tracking
// sweep.
//
// Batch ARCH-3 (rollout slice 11 — paired with signal_outcomes). The module owns
// the column names + snake↔camel mapping + chunking; the cooldown / forward-
// tracking policy (the dedup-to-newest map, the elapsed-offset math) stays in the
// crons. Same SQL, no behavior change. See docs/arch/target-architecture.md.

import { TableModule } from './TableModule.js';

/** One signal fire as the scorer records it (camelCase). */
export interface FireInsert {
  conid: number;
  signalKind: string;
  score: number;
  components: Record<string, number>;
  horizon: string;
  priceAtFire: number | null;
}

/** A recent fire for the cooldown lookup (conid + kind + when). */
export interface LastFireRow {
  conid: number;
  signalKind: string;
  fireMs: number;
}

/** A recent fire for the forward-tracking sweep (id + conid + entry + when). */
export interface RecentFireRow {
  id: string;
  conid: number;
  priceAtFire: number | null;
  fireMs: number;
}

const READ_CHUNK = 900;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

class SignalFiresTableModule extends TableModule {
  constructor() {
    super('signal_fires');
  }

  /** Record one fire. SOLE writer of signal_fires. */
  async insertFire(f: FireInsert): Promise<void> {
    await this.run(
      'insertFire',
      this.from().insert({
        conid: f.conid,
        signal_kind: f.signalKind,
        score: f.score,
        components: f.components,
        horizon: f.horizon,
        price_at_fire: f.priceAtFire,
      }),
    );
  }

  /** Recent fires of the given kinds for a set of conids since `sinceIso`,
   *  newest-first within each chunk (chunked by conid, so a conid's fires never
   *  split). The 24h cooldown read; the caller dedups to newest-per-key. */
  async getRecentByKinds(conids: number[], kinds: string[], sinceIso: string): Promise<LastFireRow[]> {
    const out: LastFireRow[] = [];
    for (let i = 0; i < conids.length; i += READ_CHUNK) {
      const rows = await this.run<Array<{ conid: unknown; signal_kind: unknown; fire_ts: unknown }>>(
        'getRecentByKinds',
        this.from()
          .select('conid, signal_kind, fire_ts')
          .in('conid', conids.slice(i, i + READ_CHUNK))
          .in('signal_kind', kinds)
          .gte('fire_ts', sinceIso)
          .order('fire_ts', { ascending: false }),
      );
      for (const r of rows ?? []) {
        const c = num(r.conid);
        const ts = new Date(String(r.fire_ts)).getTime();
        if (c == null || !Number.isFinite(ts)) continue;
        out.push({ conid: c, signalKind: String(r.signal_kind), fireMs: ts });
      }
    }
    return out;
  }

  /** All fires since `sinceIso` (id + conid + entry price + when) — the
   *  forward-tracking sweep's candidate set. */
  async getRecentSince(sinceIso: string): Promise<RecentFireRow[]> {
    const rows = await this.run<Array<{ id: unknown; conid: unknown; price_at_fire: unknown; fire_ts: unknown }>>(
      'getRecentSince',
      this.from().select('id, conid, price_at_fire, fire_ts').gte('fire_ts', sinceIso),
    );
    return (rows ?? []).map((r) => ({
      id: String(r.id),
      conid: num(r.conid) ?? 0,
      priceAtFire: num(r.price_at_fire),
      fireMs: new Date(String(r.fire_ts)).getTime(),
    }));
  }
}

export const signalFiresTableModule = new SignalFiresTableModule();
