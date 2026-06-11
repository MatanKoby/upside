// riskFlagsCron — recomputes daily-grain risk flags (Batch R1) for held +
// active-watchlist conids and persists them to `risk_flags`. Realtime then
// drives the Portfolio / Watchlist danger badge + TickerDetail Risk-flags
// section (Batch R2). The on-demand top-up at Analyze lives in signalEngine;
// this cron is the always-on coverage so badges are live before you analyze.
//
// IB-gated like entryZonesCron / intradayStatsCron — daily bars come from IB
// only, so a tick is a no-op when IB is disconnected and the next tick after
// reconnect catches up. The inputs are daily-grain, so the 60-min cadence is
// only about catching whatever window IB happens to be connected in; the flag
// values won't change until a new daily bar closes.

import { ibHistory, ibStatus } from '../services/ibGateway.js';
import { activeWatchlistOnlyConids } from '../services/quotes.js';
import { finnhub } from '../adapters/finnhub/finnhubAdapter.js';
import { userPreferencesTableModule } from '../adapters/supabase/userPreferencesTableModule.js';
import { newsSentimentTableModule } from '../adapters/supabase/newsSentimentTableModule.js';
import { quotesTableModule } from '../adapters/supabase/quotesTableModule.js';
import { positionsTableModule } from '../adapters/supabase/positionsTableModule.js';
import { notifyError } from '../services/notify.js';
import { buildRiskFlagInputs } from '../services/riskFlags/inputs.js';
import { evaluateAndStore, riskFlagAsofDate } from '../services/riskFlags/engine.js';
import { resolveRiskFlagConfig, type RiskFlagConfig } from '../config/riskFlags.js';
import type { RawIbHistory } from '../types/index.js';

const CADENCE_MS = 60 * 60_000;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

async function loadConfig(): Promise<RiskFlagConfig> {
  const prefs = await userPreferencesTableModule.getAny();
  return resolveRiskFlagConfig(prefs?.riskFlagConfig);
}

interface Target {
  conid: number;
  symbol: string;
  price: number | null;
}

async function workingSet(): Promise<Target[]> {
  const byConid = new Map<number, Target>();

  // Held positions. Price comes from the canonical quote (Batch X5 — positions
  // no longer carries current_price); the quotes-fill loop below sets it.
  for (const p of await positionsTableModule.getAllHeldConidSymbols().catch(() => [])) {
    byConid.set(p.conid, { conid: p.conid, symbol: p.symbol, price: null });
  }

  // Active-watchlist conids (excluding the held ones we already have).
  const wl = await activeWatchlistOnlyConids(new Set(byConid.keys()));
  for (const { conid, symbol } of wl) {
    if (!byConid.has(conid)) byConid.set(conid, { conid, symbol, price: null });
  }

  // Fill any missing prices from the canonical quote.
  for (const t of byConid.values()) {
    if (t.price != null) continue;
    t.price = await quotesTableModule.getCanonicalPrice(t.conid).catch(() => null);
  }
  return [...byConid.values()];
}

function highOf(hist: RawIbHistory | null): number | null {
  const highs = (hist?.data ?? []).map((b) => b.h).filter((h): h is number => Number.isFinite(h));
  return highs.length ? Math.max(...highs) : null;
}

async function tick(): Promise<void> {
  const status = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
  if (!status.authenticated || !status.connected) return; // IB off → daily bars unavailable

  const config = await loadConfig();
  const asof = riskFlagAsofDate();
  const targets = await workingSet();
  if (targets.length === 0) return;

  // Batch X7 — today's news scores (written by newsSentimentCron) for the
  // bad_news flag. One read for the whole working set; absent = unscored = null.
  const newsByConid = new Map<number, number>();
  for (const r of await newsSentimentTableModule.getByConids(
    targets.map((t) => t.conid),
    asof,
  )) {
    newsByConid.set(r.conid, r.score);
  }

  for (const { conid, symbol, price } of targets) {
    try {
      const daily = await ibHistory(conid, '1y', '1d');
      const bars = daily?.data ?? [];
      if (bars.length === 0) continue;
      const [metric, earnings] = await Promise.all([
        finnhub.basicFinancials(symbol).catch(() => null),
        finnhub.earningsCalendar(symbol).catch(() => null),
      ]);
      const inputs = buildRiskFlagInputs({
        closes: bars.map((b) => b.c),
        volumes: bars.map((b) => b.v),
        high52w: highOf(daily),
        currentPrice: price ?? num(bars[bars.length - 1]?.c),
        metric,
        earningsRaw: earnings,
        config,
        newsScore: newsByConid.get(conid) ?? null,
      });
      await evaluateAndStore(conid, inputs, config, asof);
    } catch (e) {
      void notifyError(`riskFlagsCron.${symbol}`, (e as Error).message, e);
    }
  }
}

export function startRiskFlagsCron(): void {
  console.log('[riskFlagsCron] starting, 60min cadence (IB-gated)');
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (e) {
      void notifyError('riskFlagsCron.tick', (e as Error).message, e);
    }
    setTimeout(loop, CADENCE_MS).unref();
  };
  setTimeout(loop, 45_000).unref();
}
