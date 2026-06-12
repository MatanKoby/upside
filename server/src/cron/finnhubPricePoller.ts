// finnhubPricePoller — Finnhub-sourced price fallback for held positions.
//
// Always-on, 60s cadence. For each held position in Supabase, if
// `last_price_update_at` is older than FRESHNESS_THRESHOLD_MS (90s) or null,
// fetch a Finnhub quote via the rate-limited queue and write the canonical
// price into `quotes` (Batch A1) with `canonical_source = 'finnhub'`.
//
// This is what makes the on-demand IBeam model (Batch 13) viable as a
// daily app — Upside keeps showing reasonably fresh prices even when
// the user has IB disconnected to use IBKR Mobile.
//
// Price SSOT (Batch X5): the price + P&L now live ONLY in `quotes`; this poller
// writes the quote (price + today_change_pct + today_open) and, on the
// `positions` row, just the price-source metadata + recomputed profit-zone
// state. market_value / unrealized_pnl[_pct] are computed locally only to drive
// the profit-zone check; the FE recomputes them from `quotes.canonical_price`.

import { finnhub } from '../adapters/finnhub/finnhubAdapter.js';
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { resolveOwnerUserId } from '../services/owner.js';
import { notifyError, notifyProfitZoneEntry } from '../services/notify.js';
import { computeZoneState, getProfitZoneThreshold } from '../services/profitZone.js';
import { upsertQuote } from '../services/quotes.js';
import { positionsTableModule, type PriceFillRow } from '../adapters/supabase/positionsTableModule.js';

const POLL_INTERVAL_MS = 60_000;
const FRESHNESS_THRESHOLD_MS = 90_000;

let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | null = null;

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function tick(): Promise<void> {
  try {
    const userId = await resolveOwnerUserId();
    if (!userId) return;

    // Defer entirely to IB while it's live — it's authoritative for every held
    // position and updates on its own cadence. The per-row 90s staleness check
    // below is a leaky proxy: ibPricePoller's change-detection skips the write
    // (and the last_price_update_at bump) when a price holds steady, so a quiet
    // IB price "expires" after 90s and we'd overwrite it with Finnhub's delayed
    // quote — e.g. pre-market IB 4.28 vs Finnhub's prior-close 4.18 — causing a
    // visible flicker. Only act as a fallback when IB is actually down.
    const auth = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
    if (auth.authenticated && auth.connected) return;

    const threshold = await getProfitZoneThreshold(userId);

    let rows: PriceFillRow[];
    try {
      rows = await positionsTableModule.getPriceFillRowsForUser(userId);
    } catch (e) {
      void notifyError('finnhubPricePoller.read', (e as Error).message);
      return;
    }
    if (rows.length === 0) return;

    // Filter to positions whose last update is stale.
    const now = Date.now();
    const stale = rows.filter((r) => {
      if (!r.lastPriceUpdateAt) return true;
      const age = now - new Date(r.lastPriceUpdateAt).getTime();
      return age > FRESHNESS_THRESHOLD_MS;
    });
    if (stale.length === 0) return;

    // Fetch + update each stale position. The queue rate-limits us; per-call
    // failures don't stop the loop.
    for (const p of stale) {
      try {
        const quote = await finnhub.getQuote(p.symbol);
        if (!quote || quote.c == null || quote.c === 0) {
          // Finnhub returns zeros for unknown symbols. Skip silently.
          continue;
        }
        const currentPrice = num(quote.c);
        const prevClose = num(quote.pc);
        const todayChangePct = prevClose > 0 ? (currentPrice / prevClose - 1) * 100 : null;
        const shares = num(p.shares);
        const avgCost = num(p.avgCost);
        const marketValue = currentPrice * shares;
        const costBasis = avgCost * shares;
        const unrealizedPnl = marketValue - costBasis;
        const unrealizedPnlPct = costBasis !== 0 ? (unrealizedPnl / costBasis) * 100 : null;

        // Recompute profit-taking-zone state from the new P&L (Batch 14c).
        const zone = computeZoneState(
          {
            zone_entered_at: p.zoneEnteredAt,
            zone_exited_at: p.zoneExitedAt,
            last_zone_notification_at: p.lastZoneNotificationAt,
            entered_zone_via_gap: Boolean(p.enteredZoneViaGap),
          },
          unrealizedPnlPct,
          threshold,
        );

        // Price/P&L live in `quotes` now (Batch X5) — the positions write only
        // carries the price-source metadata + recomputed zone state. The local
        // marketValue / unrealizedPnl[Pct] above still feed the quotes mirror +
        // the zone check below.
        const nowIso = new Date().toISOString();
        let updateErr: string | null = null;
        try {
          await positionsTableModule.markFinnhubPriced(userId, p.symbol, nowIso, zone.fields);
        } catch (e) {
          updateErr = (e as Error).message;
        }
        // Mirror this Finnhub price into the canonical `quotes` table
        // (Batch A1). IB is currently off (otherwise this poller is
        // skipping), so Finnhub IS the canonical right now → setCanonical
        // defaults true for source='finnhub' too in that case.
        if (Number.isFinite(p.conid) && Number.isFinite(currentPrice)) {
          const todayOpen = num(quote.o);
          await upsertQuote({
            conid: Number(p.conid),
            symbol: p.symbol,
            source: 'finnhub',
            price: currentPrice,
            setCanonical: true,
            todayChangePct,
            todayOpen,
          });
        }

        if (updateErr) {
          void notifyError(`finnhubPricePoller.update.${p.symbol}`, updateErr);
          continue;
        }
        if (zone.notify && unrealizedPnlPct != null) {
          void notifyProfitZoneEntry({
            symbol: p.symbol,
            pnlPct: unrealizedPnlPct,
            thresholdPct: threshold,
            viaGap: zone.fields.entered_zone_via_gap,
          });
        }
      } catch (e: unknown) {
        void notifyError(`finnhubPricePoller.quote.${p.symbol}`,
          (e as Error).message ?? 'quote fetch failed', e);
      }
    }

  } catch (e) {
    void notifyError('finnhubPricePoller.tick', (e as Error).message ?? 'unknown', e);
  } finally {
    if (!stopRequested) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }
}

export function startFinnhubPricePoller(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  console.log(
    `[finnhubPricePoller] starting; ${POLL_INTERVAL_MS / 1000}s cadence, ` +
    `fallback when last_price_update_at >${FRESHNESS_THRESHOLD_MS / 1000}s old`,
  );
  void tick();
}

export function stopFinnhubPricePoller(): void {
  stopRequested = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  running = false;
}
