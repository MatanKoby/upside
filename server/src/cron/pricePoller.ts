// pricePoller — pulls positions + market data from IB and writes to Supabase.
//
// Always polls when IB is connected, regardless of market state — held
// positions (and IB's last-known snapshot prices) are returned by the API
// even outside trading hours. The cadence adapts:
//   regular market hours: every 10s
//   pre/post-market:      every 60s
//   closed (weekends, holidays, overnight): every 5 min
//
// Stops polling cleanly when:
//   - IB session is expired or container stopped (sleeps 30s between checks)
//   - no whitelisted Supabase user has signed in yet (sleeps 60s)
//   - no IB account discoverable (sleeps 30s)

import { supabase } from '../services/supabase.js';
import {
  ibPositions,
  ibSnapshot,
  ibHistory,
  ibContractInfo,
  ibStatus,
} from '../services/ibGateway.js';
import {
  ibPositionToPartial,
  ibContractInfoToContract,
  currentVwap,
  ibBarToOhlc,
} from '../services/ibMappers.js';
import { resolveOwnerUserId, resolveAccountId } from '../services/owner.js';
import { notifyError, notifyCritical } from '../services/notify.js';
import { marketPeriodAt } from '../utils/marketHours.js';
import type { RawIbPosition, RawIbSnapshot, RawIbHistory, OhlcBar } from '../types/index.js';

// Polling cadences, in ms. We always poll at least once when IB is connected;
// these dictate the gap between successful cycles.
const POLL_INTERVAL_REGULAR_MS = 10_000;
const POLL_INTERVAL_EXTENDED_MS = 60_000;       // pre-market / after-hours
const POLL_INTERVAL_CLOSED_MS  = 5 * 60_000;    // weekends / overnight
const AUTH_BACKOFF_MS = 30_000;
const OWNER_BACKOFF_MS = 60_000;
const ACCOUNT_BACKOFF_MS = 30_000;

// How fresh contracts cache entries must be before we refresh.
const CONTRACTS_REFRESH_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let running = false;
let stopRequested = false;
let lastSuccessfulCycleAt: number | null = null;

/** Unix-ms timestamp of the most recent pollCycle that completed without
 *  throwing. Null until the first success. Surfaced by /healthz. */
export function getLastPricePollAt(): number | null {
  return lastSuccessfulCycleAt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface ContractsCacheRow {
  conid: number;
  symbol: string;
  company_name: string | null;
  industry: string | null;
  category: string | null;
  asset_class: string;
  currency: string;
  exchange: string | null;
  valid_exchanges: string | null;
  refreshed_at: string;
}

async function ensureContractCached(conid: number, symbol: string): Promise<ContractsCacheRow | null> {
  const { data: existing } = await supabase()
    .from('contracts')
    .select('*')
    .eq('conid', conid)
    .maybeSingle();

  const stale = !existing
    || (Date.now() - new Date(existing.refreshed_at).getTime()) > CONTRACTS_REFRESH_AGE_MS;
  if (!stale) return existing as ContractsCacheRow;

  const raw = await ibContractInfo(conid);
  if (!raw) return (existing as ContractsCacheRow | null) ?? null;

  const contract = ibContractInfoToContract(raw);
  const row: ContractsCacheRow = {
    conid: contract.conid,
    symbol: contract.symbol || symbol,
    company_name: contract.companyName,
    industry: contract.industry,
    category: contract.category,
    asset_class: contract.assetClass,
    currency: contract.currency,
    exchange: contract.exchange,
    valid_exchanges: contract.validExchanges,
    refreshed_at: contract.refreshedAt,
  };
  const { error: upErr } = await supabase().from('contracts').upsert(row, { onConflict: 'conid' });
  if (upErr) void notifyError('pricePoller.contracts.upsert', upErr.message);
  return row;
}

// Today's intraday bars for VWAP. Period 1d / bar 5mins gives ~78 bars during
// regular hours — enough resolution for the running VWAP without hammering IB.
async function todaysBars(conid: number): Promise<OhlcBar[]> {
  const raw: RawIbHistory | null = await ibHistory(conid, '1d', '5mins');
  if (!raw || !Array.isArray(raw.data)) return [];
  return raw.data.map(ibBarToOhlc);
}

interface AssembledPosition {
  user_id: string;
  conid: number;
  account_id: string;
  symbol: string;
  company_name: string | null;
  shares: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number | null;
  realized_pnl: number | null;
  today_change: number | null;
  today_change_pct: number | null;
  vwap_value: number | null;
  vwap_updated_at: string | null;
  portfolio_weight: number;
  portfolio_contribution: number;
  daily_return: number | null;
  trading_days_held: number | null;
  currency: string;
  asset_class: string;
  industry: string | null;
  category: string | null;
  updated_at: string;
}

function snapNum(snap: RawIbSnapshot | undefined, code: string): number | null {
  if (!snap) return null;
  return num(snap[code]);
}

async function assemblePosition(
  raw: RawIbPosition,
  snap: RawIbSnapshot | undefined,
  contract: ContractsCacheRow | null,
  userId: string,
): Promise<AssembledPosition> {
  const partial = ibPositionToPartial(raw);
  const bars = await todaysBars(partial.conid);
  const vwap = currentVwap(bars);
  const prevClose = snapNum(snap, '7296');
  const todayChange = prevClose != null ? partial.currentPrice - prevClose : null;
  const todayChangePct = todayChange != null && prevClose ? (todayChange / prevClose) * 100 : null;
  const costBasis = partial.shares * partial.avgCost;
  const unrealizedPnlPct = costBasis !== 0 ? (partial.unrealizedPnl / costBasis) * 100 : null;

  return {
    user_id: userId,
    conid: partial.conid,
    account_id: partial.accountId,
    symbol: partial.symbol,
    company_name: contract?.company_name ?? null,
    shares: partial.shares,
    avg_cost: partial.avgCost,
    current_price: partial.currentPrice,
    market_value: partial.marketValue,
    unrealized_pnl: partial.unrealizedPnl,
    unrealized_pnl_pct: unrealizedPnlPct,
    realized_pnl: partial.realizedPnl,
    today_change: todayChange,
    today_change_pct: todayChangePct,
    vwap_value: vwap,
    vwap_updated_at: vwap != null ? new Date().toISOString() : null,
    // Portfolio-level fields filled after we have the full set:
    portfolio_weight: 0,
    portfolio_contribution: 0,
    daily_return: null,            // TODO Batch 9-followup: needs trading_days_held first
    trading_days_held: null,       // TODO Batch 9-followup: pull from IB transactions
    currency: partial.currency,
    asset_class: partial.assetClass,
    industry: contract?.industry ?? null,
    category: contract?.category ?? null,
    updated_at: new Date().toISOString(),
  };
}

function finalizePortfolioMetrics(rows: AssembledPosition[]): void {
  const total = rows.reduce((acc, r) => acc + (r.market_value || 0), 0);
  if (total <= 0) return;
  for (const r of rows) {
    r.portfolio_weight = r.market_value / total;
    if (r.unrealized_pnl_pct != null) {
      r.portfolio_contribution = (r.unrealized_pnl_pct / 100) * r.portfolio_weight;
    }
  }
}

async function pollCycle(userId: string, accountId: string): Promise<void> {
  const positions: RawIbPosition[] = await ibPositions(accountId);
  if (positions.length === 0) {
    // No positions: zero out any stale rows for this user.
    await supabase().from('positions').delete().eq('user_id', userId);
    return;
  }

  const conids = positions.map((p) => p.conid);
  const snapshots = await ibSnapshot(conids);
  const snapByConid = new Map<number, RawIbSnapshot>();
  for (const s of snapshots) snapByConid.set(s.conid, s);

  const assembled: AssembledPosition[] = [];
  for (const raw of positions) {
    const contract = await ensureContractCached(raw.conid, raw.contractDesc);
    const snap = snapByConid.get(raw.conid);
    assembled.push(await assemblePosition(raw, snap, contract, userId));
  }
  finalizePortfolioMetrics(assembled);

  // Upsert (user_id, symbol). Skip a row if nothing changed.
  const { data: existing } = await supabase()
    .from('positions')
    .select('symbol, current_price, market_value, unrealized_pnl, vwap_value, shares, avg_cost')
    .eq('user_id', userId);

  const existingMap = new Map<string, Record<string, unknown>>();
  for (const r of existing ?? []) existingMap.set(r.symbol, r);

  const toUpsert: AssembledPosition[] = [];
  for (const r of assembled) {
    const e = existingMap.get(r.symbol);
    if (!e) { toUpsert.push(r); continue; }
    // change detection — only the fields users see ticking
    if (
      Number(e.current_price) !== r.current_price
      || Number(e.market_value) !== r.market_value
      || Number(e.unrealized_pnl) !== r.unrealized_pnl
      || Number(e.vwap_value ?? NaN) !== (r.vwap_value ?? NaN)
      || Number(e.shares) !== r.shares
      || Number(e.avg_cost) !== r.avg_cost
    ) {
      toUpsert.push(r);
    }
  }

  if (toUpsert.length === 0) return;

  const { error } = await supabase()
    .from('positions')
    .upsert(toUpsert, { onConflict: 'user_id,symbol' });
  if (error) void notifyError('pricePoller.positions.upsert', error.message);

  // Delete rows for symbols no longer held.
  const heldSymbols = new Set(assembled.map((r) => r.symbol));
  const orphans = (existing ?? []).filter((r) => !heldSymbols.has(r.symbol));
  if (orphans.length > 0) {
    await supabase()
      .from('positions')
      .delete()
      .eq('user_id', userId)
      .in('symbol', orphans.map((o) => o.symbol));
  }
}

function intervalFor(period: ReturnType<typeof marketPeriodAt>): number {
  switch (period) {
    case 'regular':
      return POLL_INTERVAL_REGULAR_MS;
    case 'pre-market':
    case 'after-hours':
      return POLL_INTERVAL_EXTENDED_MS;
    case 'closed':
    default:
      return POLL_INTERVAL_CLOSED_MS;
  }
}

async function loop(): Promise<void> {
  while (!stopRequested) {
    // Auth gates the cycle (no point hitting IB without a session). Market
    // state only controls the post-cycle sleep — held positions and IB's
    // last-known snapshot prices are returned regardless of trading hours.
    const auth = await ibStatus().catch(() => ({ authenticated: false, connected: false }));
    if (!auth.authenticated || !auth.connected) {
      await sleep(AUTH_BACKOFF_MS);
      continue;
    }

    const userId = await resolveOwnerUserId();
    if (!userId) {
      await sleep(OWNER_BACKOFF_MS);
      continue;
    }

    const accountId = await resolveAccountId();
    if (!accountId) {
      await sleep(ACCOUNT_BACKOFF_MS);
      continue;
    }

    try {
      await pollCycle(userId, accountId);
      lastSuccessfulCycleAt = Date.now();
    } catch (e) {
      void notifyError('pricePoller.cycle', (e as Error).message ?? 'unknown', e);
    }

    await sleep(intervalFor(marketPeriodAt()));
  }
}

export function startPricePoller(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  console.log(
    `[pricePoller] starting; intervals: regular=${POLL_INTERVAL_REGULAR_MS}ms, ` +
    `extended=${POLL_INTERVAL_EXTENDED_MS}ms, closed=${POLL_INTERVAL_CLOSED_MS}ms`,
  );
  void loop().catch((e) => {
    void notifyCritical('pricePoller.loop.crashed', 'loop terminated unexpectedly', e);
    running = false;
  });
}

export function stopPricePoller(): void {
  stopRequested = true;
  running = false;
}
