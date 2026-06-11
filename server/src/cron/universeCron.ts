// universeCron — Batch S1 (post-MVP screener track).
//
// Once-a-day pass that materializes the screener universe:
//   1. Pull Finnhub /stock/symbol?exchange=US (~30,538 rows).
//   2. In-process type + MIC filter (Common Stock + ADR on XNAS / XNYS / XASE
//      → ~5,307 surviving rows). Saves the majority of the rate-limit budget.
//   3. Per-symbol /quote + /stock/profile2 (queued — ~2 calls/sec at free
//      tier). Apply Ring 1 price + cap gate, upsert `universe` row with the
//      result enum.
//   4. Mark stale rows (no last_filter_pass in 30 days) for retention.
//
// Cadence: 24h, kicked off ~5 min after api startup (matches the existing
// intradayStatsCron pattern). Wall-clock target ~09:00 IDT so the user wakes
// to a fresh universe; not pinned to a clock today — runs whenever startup
// happens, then every 24h thereafter. (Aligning to a specific hour comes
// later if needed.)
//
// Mode flag — 'nightly' is the default full sweep. 'premarket' is a stub for
// S2's dynamic-universe-inclusion pass; for v1 it's a no-op (logs + returns)
// because the daily-bar volume-gap pipeline lands in S2.

import { notifyError } from '../services/notify.js';
import { getSymbolList, getQuote, getProfile2 } from '../services/finnhub.js';
import { universeTableModule, type ScoredUniverseRow } from '../adapters/supabase/universeTableModule.js';
import {
  filterRing1,
  preFilterByTypeAndMic,
} from '../services/screener/universeFilter.js';

const CADENCE_MS = 24 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;
const RETENTION_DAYS = 30;

// Finnhub's /stock/symbol payload doesn't carry IBKR conids — the upstream is
// figi/cusip-keyed. Until we have conid resolution (post-MVP Watchlist track
// will add it via IB secdef/search calls), we key `universe.conid` by a
// stable synthetic derived from the symbol + mic so the table has a primary
// key and re-runs are idempotent. When we wire real conid resolution this
// turns into a one-shot migration to back-fill real conids and a key swap.
//
// Synthetic conids are negative to avoid colliding with any real IB conid
// (which are positive bigints). FNV-1a hash on `mic|symbol` truncated to 53
// bits then negated. Stable across runs.
function syntheticConid(symbol: string, mic: string | null): number {
  const input = `${mic ?? ''}|${symbol}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  // Keep within JS safe-integer + negative sign.
  return -Number(BigInt(hash) & 0x1fffffffffffffn);
}

async function upsertBatch(rows: ScoredUniverseRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await universeTableModule.upsertScored(rows);
  } catch (e) {
    void notifyError('universeCron.upsert', `upsert of ${rows.length} rows failed: ${(e as Error).message}`);
  }
}

async function retentionPass(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  try {
    const count = await universeTableModule.purgeStaleBefore(cutoff);
    if (count > 0) {
      console.log(`[universeCron] retention removed ${count} rows older than ${RETENTION_DAYS}d`);
    }
  } catch (e) {
    void notifyError('universeCron.retention', `retention sweep failed: ${(e as Error).message}`);
  }
}

async function nightlyPass(): Promise<void> {
  const t0 = Date.now();
  console.log('[universeCron] starting nightly sweep…');

  const all = await getSymbolList('US').catch((e: Error) => {
    void notifyError('universeCron.symbolList', `getSymbolList failed: ${e.message}`, e);
    return [];
  });
  if (all.length === 0) {
    console.log('[universeCron] symbol list empty — aborting sweep');
    return;
  }
  const pool = all.filter(preFilterByTypeAndMic);
  console.log(
    `[universeCron] pool: ${all.length} total → ${pool.length} after type+MIC sieve (${Math.round(
      (pool.length / all.length) * 100,
    )}% kept)`,
  );

  const nowIso = new Date().toISOString();
  const batch: ScoredUniverseRow[] = [];
  const BATCH_SIZE = 100;
  let scored = 0;
  let kept = 0;
  let skipped = 0;

  for (const row of pool) {
    const symbol = row.symbol;
    if (!symbol) {
      skipped++;
      continue;
    }
    try {
      const [quote, profile] = await Promise.all([
        getQuote(symbol).catch(() => null),
        getProfile2(symbol).catch(() => null),
      ]);
      const price = quote?.c ?? null;
      const marketCapM = profile?.marketCapitalization ?? null;

      const filterResult = filterRing1({
        type: row.type ?? null,
        mic: row.mic ?? null,
        price,
        marketCapM,
        // avgVolume deferred — S2 wires it via the daily-bar pipeline.
        avgVolume: null,
      });

      batch.push({
        conid: syntheticConid(symbol, row.mic ?? null),
        symbol,
        type: row.type ?? null,
        mic: row.mic ?? null,
        filterResult,
        lastPrice: price,
        lastMarketCapM: marketCapM,
        lastAvgVolume: null,
        lastFilterPass: nowIso,
        computedAt: nowIso,
      });
      scored++;
      if (filterResult === 'in') kept++;
    } catch (e) {
      skipped++;
      void notifyError(`universeCron.${symbol}`, (e as Error).message, e);
    }

    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(batch.splice(0, batch.length));
    }
    if (scored % 500 === 0 && scored > 0) {
      const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
      console.log(`[universeCron] progress: scored=${scored}/${pool.length} kept=${kept} elapsed=${elapsedMin}m`);
    }
  }
  // Flush remainder.
  await upsertBatch(batch);

  const elapsedMin = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(
    `[universeCron] done: scored=${scored} kept=${kept} skipped=${skipped} elapsed=${elapsedMin}m`,
  );

  await retentionPass();
}

// Stub for S2 — pre-market sweep is where the dynamic-universe-inclusion
// (3× volume-gap promotion) will live. Lands when S2's daily-bar pipeline
// arrives. For S1 we log + return.
async function premarketPass(): Promise<void> {
  console.log('[universeCron] premarket pass: stub (volume-gap promotion lands in S2)');
}

async function tick(mode: 'nightly' | 'premarket' = 'nightly'): Promise<void> {
  if (mode === 'premarket') {
    await premarketPass();
    return;
  }
  await nightlyPass();
}

export function startUniverseCron(): void {
  console.log('[universeCron] starting, 24h cadence');
  const loop = async () => {
    try {
      await tick('nightly');
    } catch (e) {
      void notifyError('universeCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, FIRST_RUN_DELAY_MS).unref();
}

// Exported for the `npm run cron:universe` one-shot + for vitest.
export const __test = { tick, nightlyPass, premarketPass, syntheticConid };
