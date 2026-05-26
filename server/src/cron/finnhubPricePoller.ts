// finnhubPricePoller — Finnhub-sourced fallback for `current_price` updates.
//
// Always-on, 60s cadence. For each held position in Supabase, if
// `last_price_update_at` is older than FRESHNESS_THRESHOLD_MS (90s) or
// null, fetch a Finnhub quote via the rate-limited queue and overwrite
// the price-derived fields with `price_source = 'finnhub'`.
//
// This is what makes the on-demand IBeam model (Batch 13) viable as a
// daily app — Upside keeps showing reasonably fresh prices even when
// the user has IB disconnected to use IBKR Mobile.
//
// Scope of fields updated (per spec, this is a fallback — we update
// only price-driven fields, never authoritative-from-IB ones like
// shares, avg_cost, vwap, daily_return, trading_days_held):
//   - current_price
//   - market_value          (= shares * current_price)
//   - unrealized_pnl        (= market_value - shares*avg_cost)
//   - unrealized_pnl_pct    (= unrealized_pnl / cost_basis * 100)
//   - today_change          (= current_price - prev_close)
//   - today_change_pct
//   - price_source          ('finnhub')
//   - last_price_update_at  (now)
//   - portfolio_weight      (recomputed across the full user portfolio at end of cycle)
//   - portfolio_contribution (same)
//   - updated_at

import { supabase } from '../services/supabase.js';
import { getQuote } from '../services/finnhub.js';
import { resolveOwnerUserId } from '../services/owner.js';
import { notifyError, notifyZoneEntry } from '../services/notify.js';
import { computeZoneState, getProfitZoneThreshold } from '../services/profitZone.js';

const POLL_INTERVAL_MS = 60_000;
const FRESHNESS_THRESHOLD_MS = 90_000;

let running = false;
let stopRequested = false;
let timer: NodeJS.Timeout | null = null;

interface PositionRow {
  symbol: string;
  shares: number | string | null;
  avg_cost: number | string | null;
  last_price_update_at: string | null;
  // Profit-taking zone state (Batch 14c) — carried so we can recompute on write.
  zone_entered_at: string | null;
  zone_exited_at: string | null;
  last_zone_notification_at: string | null;
  entered_zone_via_gap: boolean | null;
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function tick(): Promise<void> {
  try {
    const userId = await resolveOwnerUserId();
    if (!userId) return;

    const threshold = await getProfitZoneThreshold(userId);

    const { data: rows, error } = await supabase()
      .from('positions')
      .select('symbol, shares, avg_cost, last_price_update_at, market_value, zone_entered_at, zone_exited_at, last_zone_notification_at, entered_zone_via_gap')
      .eq('user_id', userId);
    if (error) {
      void notifyError('finnhubPricePoller.read', error.message);
      return;
    }
    if (!rows || rows.length === 0) return;

    // Filter to positions whose last update is stale.
    const now = Date.now();
    const stale = (rows as PositionRow[]).filter((r) => {
      if (!r.last_price_update_at) return true;
      const age = now - new Date(r.last_price_update_at).getTime();
      return age > FRESHNESS_THRESHOLD_MS;
    });
    if (stale.length === 0) return;

    // Fetch + update each stale position. The queue rate-limits us; per-call
    // failures don't stop the loop.
    let anyUpdated = false;
    for (const p of stale) {
      try {
        const quote = await getQuote(p.symbol);
        if (!quote || quote.c == null || quote.c === 0) {
          // Finnhub returns zeros for unknown symbols. Skip silently.
          continue;
        }
        const currentPrice = num(quote.c);
        const prevClose = num(quote.pc);
        const todayChange = prevClose > 0 ? currentPrice - prevClose : null;
        const todayChangePct = prevClose > 0 ? (currentPrice / prevClose - 1) * 100 : null;
        const shares = num(p.shares);
        const avgCost = num(p.avg_cost);
        const marketValue = currentPrice * shares;
        const costBasis = avgCost * shares;
        const unrealizedPnl = marketValue - costBasis;
        const unrealizedPnlPct = costBasis !== 0 ? (unrealizedPnl / costBasis) * 100 : null;

        // Recompute profit-taking-zone state from the new P&L (Batch 14c).
        const zone = computeZoneState(
          {
            zone_entered_at: p.zone_entered_at,
            zone_exited_at: p.zone_exited_at,
            last_zone_notification_at: p.last_zone_notification_at,
            entered_zone_via_gap: Boolean(p.entered_zone_via_gap),
          },
          unrealizedPnlPct,
          threshold,
        );

        const { error: upErr } = await supabase()
          .from('positions')
          .update({
            current_price: currentPrice,
            market_value: marketValue,
            unrealized_pnl: unrealizedPnl,
            unrealized_pnl_pct: unrealizedPnlPct,
            today_change: todayChange,
            today_change_pct: todayChangePct,
            price_source: 'finnhub',
            last_price_update_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...zone.fields,
          })
          .eq('user_id', userId)
          .eq('symbol', p.symbol);
        if (upErr) {
          void notifyError(`finnhubPricePoller.update.${p.symbol}`, upErr.message);
          continue;
        }
        if (zone.notify && unrealizedPnlPct != null) {
          void notifyZoneEntry({
            symbol: p.symbol,
            pnlPct: unrealizedPnlPct,
            thresholdPct: threshold,
            viaGap: zone.fields.entered_zone_via_gap,
          });
        }
        anyUpdated = true;
      } catch (e: unknown) {
        void notifyError(`finnhubPricePoller.quote.${p.symbol}`,
          (e as Error).message ?? 'quote fetch failed', e);
      }
    }

    if (anyUpdated) {
      // Recompute portfolio_weight + portfolio_contribution across the
      // full user portfolio so totals stay consistent after a partial
      // price refresh. Cheap relative to the per-symbol quote calls.
      const { data: allRows } = await supabase()
        .from('positions')
        .select('symbol, market_value, unrealized_pnl_pct')
        .eq('user_id', userId);
      if (allRows && allRows.length > 0) {
        const total = allRows.reduce((acc, r) => acc + num(r.market_value as number | string | null), 0);
        if (total > 0) {
          for (const r of allRows) {
            const mv = num(r.market_value as number | string | null);
            const pnlPct = r.unrealized_pnl_pct == null ? null : num(r.unrealized_pnl_pct as number | string | null);
            const weight = mv / total;
            const contribution = pnlPct == null ? 0 : (pnlPct / 100) * weight;
            await supabase()
              .from('positions')
              .update({ portfolio_weight: weight, portfolio_contribution: contribution })
              .eq('user_id', userId)
              .eq('symbol', r.symbol as string);
          }
        }
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
