// catalystReversalProducer — Batch S2.
//
// Three-stage daily producer per spec/signals/screener-universe.md →
// catalyst_reversal. All cross-stage routing lives here (per
// spec/job-queue.md — workers never decide dependencies).
//
//   Stage 0 (inline): Finnhub /calendar/earnings for the last 3 trading
//     days → reporter set. (News-sentiment sweep deferred — see CLAIMS
//     note for the follow-up slice.) Candidate set = universe IN ∩
//     (recently-reported) ∪ already-auto-promoted carryovers.
//   Stage 1: per-candidate IB snapshot, evaluate vol-multiple + move via
//     pure evaluateCatalystStage1. Worker action 'eval_catalyst_stage1'
//     on the `ib` pool returns a CatalystStage1Result via job.result.
//   Stage 2: per Stage-1 qualifier, ibHistory(1y, 1d), evaluate A ∧ B via
//     pure evaluateCatalystStage2. Worker action 'eval_catalyst_stage2'
//     on the `ib` pool returns {score, payload}. Survivors → trait_scores
//     + universe.auto_promoted=true + notifyTraitFirstFire on first fire.
//
// Two loops (Batch X10.2 — same-session catalyst):
//   produce (24h, boot+2min): recompute the Stage-0 candidate set + enqueue
//     Stage-1. Candidates change daily.
//   advance (~2min): drain Stage-1 done → enqueue Stage-2; drain Stage-2 done →
//     trait_scores; + failure retries. DB-only (no IB), so it carries each conid
//     through the stages within minutes of the workers finishing — rather than
//     one stage per 24h tick (which put catalyst 1-2 days behind).

import { supabase } from '../services/supabase.js';
import { notifyError, notifyTraitFirstFire } from '../services/notify.js';
import { getEarningsWindow } from '../services/earningsCalendar.js';
import {
  enqueue,
  drainDone,
  drainFailed,
  deleteJob,
  markRetry,
  finalizeFailure,
  type JobRow,
} from '../services/jobs/queue.js';
import { makeKey } from '../services/jobs/keys.js';
import { ibRegistry } from '../services/jobs/actions.js';
import { gateRegistry, requiresRthOpen } from '../services/jobs/gates.js';
import { ibSnapshot, ibHistory } from '../services/ibGateway.js';
import { parseIbNumber } from '../utils/ibNumber.js';
import {
  evaluateCatalystStage1,
  evaluateCatalystStage2,
  type CatalystStage1Input,
  type CatalystStage1Result,
  type DailyBar,
} from '../services/screener/traits/catalystReversal.js';
import type { RawIbSnapshot, RawIbHistory } from '../types/index.js';

const CADENCE_MS = 24 * 60 * 60_000;        // produce loop — Stage-0 candidates refresh daily
const FIRST_RUN_DELAY_MS = 2 * 60_000;      // first produce after boot (candidate deps persist in the DB)
const ADVANCE_CADENCE_MS = 2 * 60_000;      // advance loop — drain Stage-1→2→trait_scores as workers finish
const ADVANCE_FIRST_DELAY_MS = 30_000;
const MAX_RETRY_ATTEMPTS = 2;
const LOOKBACK_TRADING_DAYS = 3;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIsoDate(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

interface UniverseTarget {
  real_conid: number;
  symbol: string;
  last_volume: number | null;
  last_avg_volume: number | null;
}

async function loadCandidateUniverseFromEarnings(): Promise<UniverseTarget[]> {
  // Bulk earnings calendar — one Finnhub call for the lookback window.
  const from = daysAgoIsoDate(LOOKBACK_TRADING_DAYS);
  let earnings;
  try {
    // Shared once-per-day calendar pull (Batch X6); filter to this lookback.
    earnings = (await getEarningsWindow()).filter((r) => r.date != null && r.date >= from);
  } catch (e) {
    void notifyError('catalystReversalProducer.earningsCal', (e as Error).message, e);
    return [];
  }
  const symbols = new Set(earnings.map((r) => r.symbol).filter((s): s is string => !!s));
  if (symbols.size === 0) return [];

  // Join earnings symbols → universe rows. Filter to universe IN with
  // real_conid resolved (the catalyst trait needs IB-keyed data
  // downstream). Filtered-OUT universe rows get included too once the
  // dynamic-inclusion path lands — see spec → Dynamic universe inclusion;
  // for v1 we stay inside Ring-1 IN to limit Stage-1 IB cost.
  const allowed = Array.from(symbols);
  const out: UniverseTarget[] = [];
  for (let i = 0; i < allowed.length; i += 900) {
    const chunk = allowed.slice(i, i + 900);
    const { data, error } = await supabase()
      .from('universe')
      .select('real_conid, symbol, last_volume, last_avg_volume')
      .eq('filter_result', 'in')
      .not('real_conid', 'is', null)
      .in('symbol', chunk);
    if (error) {
      void notifyError('catalystReversalProducer.loadCandidates', error.message);
      continue;
    }
    out.push(...((data ?? []) as UniverseTarget[]));
  }
  return out;
}

async function enqueueStage1(targets: UniverseTarget[]): Promise<{ enqueued: number; deduped: number }> {
  const asof = todayIsoDate();
  let enqueued = 0, deduped = 0;
  for (const t of targets) {
    if (t.real_conid == null) continue;
    const jobKey = makeKey('eval_catalyst_stage1', t.real_conid, asof);
    try {
      const r = await enqueue(jobKey, 'eval_catalyst_stage1', 'ib', {
        real_conid: t.real_conid,
        symbol: t.symbol,
        baseline_volume: t.last_avg_volume ?? t.last_volume,
        asof_date: asof,
      });
      if (r === 'created') enqueued++; else deduped++;
    } catch (e) {
      void notifyError(`catalystReversalProducer.enqueueS1.${t.symbol}`, (e as Error).message);
    }
  }
  return { enqueued, deduped };
}

async function drainStage1(): Promise<{ promoted: number; dropped: number; retried: number; gave_up: number }> {
  const done = await drainDone('eval_catalyst_stage1').catch((e: Error) => {
    void notifyError('catalystReversalProducer.drainS1Done', e.message);
    return [] as JobRow[];
  });
  let promoted = 0, dropped = 0;
  for (const j of done) {
    const r = j.result as unknown as CatalystStage1Result | undefined;
    const payload = j.payload as { real_conid?: number; symbol?: string; asof_date?: string };
    if (r && r.qualified && payload.real_conid != null && payload.symbol && payload.asof_date) {
      const jobKey2 = makeKey('eval_catalyst_stage2', payload.real_conid, payload.asof_date);
      try {
        await enqueue(jobKey2, 'eval_catalyst_stage2', 'ib', {
          real_conid: payload.real_conid,
          symbol: payload.symbol,
          asof_date: payload.asof_date,
          vol_multiple: r.vol_multiple,
          today_move_pct: r.today_move_pct,
          today_gap_pct: r.today_gap_pct,
        });
        promoted++;
      } catch (e) {
        void notifyError(`catalystReversalProducer.enqueueS2.${payload.symbol}`, (e as Error).message);
      }
    } else {
      dropped++;
    }
    await deleteJob(j.id).catch(() => undefined);
  }

  const failed = await drainFailed('eval_catalyst_stage1').catch((e: Error) => {
    void notifyError('catalystReversalProducer.drainS1Failed', e.message);
    return [] as JobRow[];
  });
  let retried = 0, gave_up = 0;
  for (const j of failed) {
    if (j.attempts < MAX_RETRY_ATTEMPTS) {
      await markRetry(j).catch(() => undefined);
      retried++;
    } else {
      await finalizeFailure(j).catch(() => undefined);
      gave_up++;
    }
  }
  return { promoted, dropped, retried, gave_up };
}

async function drainStage2(): Promise<{ scored: number; nulled: number; retried: number; gave_up: number }> {
  const done = await drainDone('eval_catalyst_stage2').catch((e: Error) => {
    void notifyError('catalystReversalProducer.drainS2Done', e.message);
    return [] as JobRow[];
  });
  let scored = 0, nulled = 0;
  const nowIso = new Date().toISOString();
  for (const j of done) {
    const payload = j.payload as { real_conid?: number; symbol?: string; asof_date?: string };
    const r = j.result as unknown as { score: number | null; payload: Record<string, unknown> } | undefined;
    if (!r || payload.real_conid == null || !payload.symbol || !payload.asof_date) {
      await deleteJob(j.id).catch(() => undefined);
      continue;
    }
    if (r.score == null) {
      // A ∧ B didn't hold — Stage-1 alone isn't enough; drop quietly.
      nulled++;
      await deleteJob(j.id).catch(() => undefined);
      continue;
    }
    const { error } = await supabase()
      .from('trait_scores')
      .upsert(
        {
          conid: payload.real_conid,
          trait: 'catalyst_reversal',
          asof_date: payload.asof_date,
          score: r.score,
          payload: r.payload,
          computed_at: nowIso,
        },
        { onConflict: 'conid,trait,asof_date' },
      );
    if (error) {
      void notifyError(`catalystReversalProducer.upsert.${payload.symbol}`, error.message);
      continue;
    }
    // Auto-promote so other traits + the FE pick it up regardless of
    // Ring-1 IN status.
    await supabase()
      .from('universe')
      .update({ auto_promoted: true })
      .eq('real_conid', payload.real_conid);

    // First-fire ping — gate on last_fired_at to keep idempotent re-runs
    // quiet. Atomic UPDATE … RETURNING via PostgREST returns rows only
    // when the condition matched.
    const { data: stamped } = await supabase()
      .from('trait_scores')
      .update({ last_fired_at: nowIso })
      .eq('conid', payload.real_conid)
      .eq('trait', 'catalyst_reversal')
      .eq('asof_date', payload.asof_date)
      .is('last_fired_at', null)
      .select('conid');
    if (stamped && stamped.length > 0) {
      void notifyTraitFirstFire({
        trait: 'catalyst_reversal',
        symbol: payload.symbol,
        score: r.score,
        payload: r.payload,
      });
    }
    scored++;
    await deleteJob(j.id).catch(() => undefined);
  }

  const failed = await drainFailed('eval_catalyst_stage2').catch((e: Error) => {
    void notifyError('catalystReversalProducer.drainS2Failed', e.message);
    return [] as JobRow[];
  });
  let retried = 0, gave_up = 0;
  for (const j of failed) {
    if (j.attempts < MAX_RETRY_ATTEMPTS) {
      await markRetry(j).catch(() => undefined);
      retried++;
    } else {
      await finalizeFailure(j).catch(() => undefined);
      gave_up++;
    }
  }
  return { scored, nulled, retried, gave_up };
}

// Produce loop (24h) — Stage-0 candidate computation + enqueue Stage-1. Enqueue
// dedups on the active job_key, so a name already in flight today is a no-op.
async function produceTick(): Promise<void> {
  const candidates = await loadCandidateUniverseFromEarnings();
  const carryovers = await loadAutoPromotedCarryovers();
  const allMap = new Map<number, UniverseTarget>();
  for (const t of [...candidates, ...carryovers]) {
    if (t.real_conid != null) allMap.set(t.real_conid, t);
  }
  const targets = Array.from(allMap.values());
  const s1en = await enqueueStage1(targets);
  console.log(
    `[catalystReversalProducer] produce: candidates=${targets.length} ` +
      `s1[enq=${s1en.enqueued} dedup=${s1en.deduped}]`,
  );
}

// Advance loop (~2min) — carry conids through the stages as the IB workers
// finish them: drainStage1 enqueues Stage-2 for qualifiers, drainStage2 writes
// trait_scores. DB-only, no IB cost. Quiet unless something actually moved.
async function advanceTick(): Promise<void> {
  const s1dr = await drainStage1();
  const s2dr = await drainStage2();
  const moved =
    s1dr.promoted || s1dr.dropped || s1dr.retried || s1dr.gave_up ||
    s2dr.scored || s2dr.nulled || s2dr.retried || s2dr.gave_up;
  if (moved) {
    console.log(
      `[catalystReversalProducer] advance: ` +
        `s1drain[promote=${s1dr.promoted} drop=${s1dr.dropped} retry=${s1dr.retried} give-up=${s1dr.gave_up}] ` +
        `s2drain[score=${s2dr.scored} null=${s2dr.nulled} retry=${s2dr.retried} give-up=${s2dr.gave_up}]`,
    );
  }
}

async function loadAutoPromotedCarryovers(): Promise<UniverseTarget[]> {
  const { data, error } = await supabase()
    .from('universe')
    .select('real_conid, symbol, last_volume, last_avg_volume')
    .eq('auto_promoted', true)
    .not('real_conid', 'is', null)
    .limit(500);
  if (error) {
    void notifyError('catalystReversalProducer.loadCarryovers', error.message);
    return [];
  }
  return (data ?? []) as UniverseTarget[];
}

export function startCatalystReversalProducer(): void {
  console.log('[catalystReversalProducer] starting: produce 24h, advance ~2min');
  const produceLoop = async () => {
    try {
      await produceTick();
    } catch (e) {
      void notifyError('catalystReversalProducer.produce', (e as Error).message, e);
    }
    setTimeout(produceLoop, CADENCE_MS).unref();
  };
  const advanceLoop = async () => {
    try {
      await advanceTick();
    } catch (e) {
      void notifyError('catalystReversalProducer.advance', (e as Error).message, e);
    }
    setTimeout(advanceLoop, ADVANCE_CADENCE_MS).unref();
  };
  setTimeout(produceLoop, FIRST_RUN_DELAY_MS).unref();
  setTimeout(advanceLoop, ADVANCE_FIRST_DELAY_MS).unref();
}

// ---------------------------------------------------------------------------
// Worker action handlers — both registered on the `ib` pool.
// ---------------------------------------------------------------------------

interface CatalystS1Payload {
  real_conid: number;
  symbol: string;
  baseline_volume: number | null;
  asof_date: string;
}

// The snapshot fields Stage-1 actually gates on: last price (31), today's open
// (7295), volume (87), prev close (7296). ibSnapshot warms the poll until all
// are present (Batch X10.1) so we don't evaluate a half-streamed row.
const CATALYST_SNAPSHOT_FIELDS = ['31', '7295', '87', '7296'] as const;

ibRegistry['eval_catalyst_stage1'] = async (payloadIn) => {
  const payload = payloadIn as unknown as CatalystS1Payload;
  if (payload.real_conid == null) throw new Error('eval_catalyst_stage1: missing real_conid');
  const rows = await ibSnapshot([payload.real_conid], CATALYST_SNAPSHOT_FIELDS);
  const row: RawIbSnapshot | undefined = rows[0];
  if (!row) throw new Error(`eval_catalyst_stage1: empty snapshot for ${payload.symbol}`);
  const input: CatalystStage1Input = {
    today_volume: parseIbNumber(row['87']),
    today_price:  parseIbNumber(row['31']),
    today_open:   parseIbNumber(row['7295']),
    prev_close:   parseIbNumber(row['7296']),
    today_high:   parseIbNumber(row['70']),
    today_low:    parseIbNumber(row['71']),
    baseline_volume: payload.baseline_volume,
  };
  if (!Number.isFinite(input.today_price) || !Number.isFinite(input.today_open)) {
    throw new Error(`eval_catalyst_stage1: snapshot missing price/open for ${payload.symbol}`);
  }
  const result = evaluateCatalystStage1(input);
  return result as unknown as Record<string, unknown>;
};

interface CatalystS2Payload {
  real_conid: number;
  symbol: string;
  asof_date: string;
  vol_multiple: number;
  today_move_pct: number;
  today_gap_pct: number | null;
}

ibRegistry['eval_catalyst_stage2'] = async (payloadIn) => {
  const payload = payloadIn as unknown as CatalystS2Payload;
  if (payload.real_conid == null) throw new Error('eval_catalyst_stage2: missing real_conid');
  const hist: RawIbHistory | null = await ibHistory(payload.real_conid, '1y', '1d');
  if (!hist?.data || hist.data.length < 200) {
    throw new Error(`eval_catalyst_stage2: insufficient daily bars for ${payload.symbol}`);
  }
  const bars: DailyBar[] = hist.data.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const today_price = bars[bars.length - 1]!.c;
  const stage2 = evaluateCatalystStage2({
    daily_bars: bars,
    vol_multiple: payload.vol_multiple,
    today_move_pct: payload.today_move_pct,
    today_gap_pct: payload.today_gap_pct,
    today_price,
  });
  return stage2 as unknown as Record<string, unknown>;
};

// Per-action gates (Batch X10): both catalyst stages need the regular session
// — Stage 1 reads a live snapshot (IBKR field 7295/today's open only exists
// intraday) and Stage 2 reads ibHistory (503s off-hours). Claimed off-hours,
// they now defer to the next 09:30 ET instead of failing + burning retries.
gateRegistry['eval_catalyst_stage1'] = requiresRthOpen();
gateRegistry['eval_catalyst_stage2'] = requiresRthOpen();
