// watchlistQuotePoller — keeps `quotes` rows fresh for watchlist-only conids
// (Batch A1). Held conids are already priced by the main pollers; this is the
// gap closer for tickers the user is *watching* but doesn't own.
//
// Cadence: 60s always-on (mirrors the Finnhub fallback poller's cadence). When
// IB is connected, one `ibSnapshot([conids])` call fetches every watchlist-
// only conid in one round-trip (subscribe-wait-fetch handles the warmup). When
// IB is off, fall back to per-symbol Finnhub `/quote` via the rate-limited
// queue. Either way the row in `quotes` gets `canonical_source` set to the
// path that actually delivered the value.

import { ibStatus, ibSnapshot } from '../services/ibGateway.js';
import { getQuote } from '../services/finnhub.js';
import { activeWatchlistOnlyConids, upsertQuote } from '../services/quotes.js';
import { positionsTableModule } from '../adapters/supabase/positionsTableModule.js';
import { notifyError } from '../services/notify.js';

const CADENCE_MS = 60_000;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function heldConidSet(): Promise<Set<number>> {
  const conids = await positionsTableModule.getAllHeldConids().catch(() => []);
  return new Set(conids);
}

async function tick(): Promise<void> {
  const held = await heldConidSet();
  const targets = await activeWatchlistOnlyConids(held);
  if (targets.length === 0) return;

  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  const ibUp = status.authenticated && status.connected;

  if (ibUp) {
    const conids = targets.map((t) => t.conid);
    const snap = await ibSnapshot(conids).catch(() => []);
    // Build a quick conid → symbol map from the targets list (the snapshot
    // payload doesn't carry our symbol, just IB's identifiers).
    const symByConid = new Map(targets.map((t) => [t.conid, t.symbol]));
    for (const row of snap) {
      const conid = Number(row.conid);
      const price = num(row['31']);
      // IB snapshot field 82 = today change %, field 7295 = today open.
      const todayChangePct = num(row['82']);
      const todayOpen = num(row['7295']);
      const symbol = symByConid.get(conid);
      if (!Number.isFinite(conid) || price == null || !symbol) continue;
      await upsertQuote({ conid, symbol, source: 'ib', price, todayChangePct, todayOpen });
    }
    return;
  }

  // IB off → Finnhub /quote per symbol, sequentially (the queue handles
  // global pacing). Stamp canonical because IB isn't available to win.
  for (const { conid, symbol } of targets) {
    if (!symbol) continue;
    const q = await getQuote(symbol).catch(() => null);
    const price = num(q?.c);
    if (price == null || price === 0) continue;
    const todayChangePct = num(q?.dp);
    const todayOpen = num(q?.o);
    await upsertQuote({ conid, symbol, source: 'finnhub', price, setCanonical: true, todayChangePct, todayOpen });
  }
}

export function startWatchlistQuotePoller(): void {
  console.log('[watchlistQuotePoller] starting, 60s cadence');
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      void notifyError('watchlistQuotePoller.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  // First tick after a short delay so the api has time to boot.
  setTimeout(loop, 5_000).unref();
}
