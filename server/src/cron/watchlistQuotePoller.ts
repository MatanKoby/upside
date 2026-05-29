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
import { supabase } from '../services/supabase.js';
import { notifyError } from '../services/notify.js';

const CADENCE_MS = 60_000;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function heldConidSet(): Promise<Set<number>> {
  const res = await supabase().from('positions').select('conid');
  const set = new Set<number>();
  for (const r of res.data ?? []) {
    const c = Number(r.conid);
    if (Number.isFinite(c)) set.add(c);
  }
  return set;
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
      // IB snapshot field 82 = today change percent (string with sign + suffix
      // sometimes; parseFloat is tolerant). Falls through to null if missing.
      const todayChangePct = num(row['82']);
      const symbol = symByConid.get(conid);
      if (!Number.isFinite(conid) || price == null || !symbol) continue;
      await upsertQuote({ conid, symbol, source: 'ib', price, todayChangePct });
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
    // Finnhub /quote returns `dp` = today change percent.
    const todayChangePct = num(q?.dp);
    await upsertQuote({ conid, symbol, source: 'finnhub', price, setCanonical: true, todayChangePct });
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
