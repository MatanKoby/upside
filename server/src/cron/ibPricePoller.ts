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

import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';
import { entryFromTrades, entryFromTransactions } from '../adapters/ib/entryDeduction.js';
import {
  ibPositionToPartial,
  ibContractInfoToContract,
  currentVwap,
  ibBarToOhlc,
} from '../services/ibMappers.js';
import { contractsTableModule } from '../adapters/supabase/contractsTableModule.js';
import type { Contract } from '../types/index.js';
import { resolveOwnerUserId, resolveAccountId } from '../services/owner.js';
import { notifyError, notifyCritical, notifyProfitZoneEntry } from '../services/notify.js';
import { marketPeriodAt, tradingDaysHeld } from '../utils/marketHours.js';
import { recordPortfolioValueForMtd } from '../services/mtdCache.js';
import { computeZoneState, getProfitZoneThreshold } from '../services/profitZone.js';
import type { RawIbPosition, RawIbSnapshot, RawIbHistory, OhlcBar } from '../types/index.js';
import { upsertQuote } from '../services/quotes.js';
import { positionsTableModule, type AssembledPosition } from '../adapters/supabase/positionsTableModule.js';

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
export function getLastIbPricePollAt(): number | null {
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

async function ensureContractCached(conid: number, symbol: string): Promise<Contract | null> {
  const existing = await contractsTableModule.getByConid(conid);

  const stale = !existing
    || (Date.now() - new Date(existing.refreshedAt).getTime()) > CONTRACTS_REFRESH_AGE_MS;
  if (!stale) return existing;

  const raw = await ibGateway.contractInfo(conid);
  if (!raw) return existing ?? null;

  const contract = ibContractInfoToContract(raw);
  const resolved: Contract = { ...contract, symbol: contract.symbol || symbol };
  try {
    await contractsTableModule.upsert(resolved);
  } catch (e: unknown) {
    void notifyError('ibPricePoller.contracts.upsert', e instanceof Error ? e.message : String(e));
  }
  return resolved;
}

// Today's intraday bars for VWAP. Period 1d / bar 5mins gives ~78 bars during
// regular hours — enough resolution for the running VWAP without hammering IB.
async function todaysBars(conid: number): Promise<OhlcBar[]> {
  const raw: RawIbHistory | null = await ibGateway.history(conid, '1d', '5mins');
  if (!raw || !Array.isArray(raw.data)) return [];
  return raw.data.map(ibBarToOhlc);
}

interface EntryInfo {
  firstSeenAt: string;
  firstSeenSource: 'observed' | 'ib_transactions';
}

// On first sight of a conid (or a row whose `first_seen_at` is NULL from the
// Batch-13.5 migration), try to deduce the true entry date from IB's last 90
// days of transactions. Fall back to now() with source='observed' if IB
// returns nothing useful — that's the floor case the FE renders as "≥N days".
// Conids whose observed→ib_transactions upgrade we've recently attempted.
// In-memory (resets on api restart, which simply re-attempts once on boot) so
// a genuinely pre-window position doesn't re-POST /pa/transactions every cycle.
const lastEntryReconcileAttempt = new Map<number, number>();
const ENTRY_RECONCILE_RETRY_MS = 60 * 60 * 1000; // retry observed floors hourly

async function resolveEntryInfo(
  raw: RawIbPosition,
  accountId: string,
  existingFirstSeenAt: string | null,
  existingFirstSeenSource: string | null,
): Promise<EntryInfo> {
  // An exact IB-transactions date is authoritative — never re-fetch it.
  if (existingFirstSeenSource === 'ib_transactions' && existingFirstSeenAt) {
    return { firstSeenAt: existingFirstSeenAt, firstSeenSource: 'ib_transactions' };
  }

  // First sight (null first_seen_at) reconciles immediately. A prior 'observed'
  // floor re-attempts the upgrade — but at most hourly per conid — so a single
  // failed first attempt no longer pins the position to 'observed' forever
  // (Batch 13.5 self-heal).
  if (existingFirstSeenAt) {
    const last = lastEntryReconcileAttempt.get(raw.conid) ?? 0;
    if (Date.now() - last < ENTRY_RECONCILE_RETRY_MS) {
      return { firstSeenAt: existingFirstSeenAt, firstSeenSource: 'observed' };
    }
  }
  lastEntryReconcileAttempt.set(raw.conid, Date.now());

  const shares = ibPositionToPartial(raw).shares;
  try {
    // Tier 1 — intraday-accurate from the ~7-day trades window. Catches a
    // recent flatten + re-open (sell-to-0 then re-buy) that day-level data
    // cannot see, e.g. the true entry is the re-buy, not the original open.
    const trades = await ibGateway.trades();
    const intraday = entryFromTrades(trades, raw.conid, shares);
    if (intraday) {
      return { firstSeenAt: intraday.toISOString(), firstSeenSource: 'ib_transactions' };
    }
    // Tier 2 — entry predates the trades window: day-level from /pa/transactions.
    const txs = await ibGateway.transactions(accountId, raw.conid);
    const dayLevel = entryFromTransactions(txs, shares);
    if (dayLevel) {
      return { firstSeenAt: dayLevel.toISOString(), firstSeenSource: 'ib_transactions' };
    }
  } catch (e) {
    void notifyError(
      `ibPricePoller.entry.${raw.conid}`,
      (e as Error).message ?? 'unknown',
      e,
    );
  }
  // Reconciliation unavailable. Preserve an existing observed floor (don't bump
  // it forward each retry); otherwise stamp the first observation now.
  return {
    firstSeenAt: existingFirstSeenAt ?? new Date().toISOString(),
    firstSeenSource: 'observed',
  };
}

function snapNum(snap: RawIbSnapshot | undefined, code: string): number | null {
  if (!snap) return null;
  return num(snap[code]);
}

async function assemblePosition(
  raw: RawIbPosition,
  snap: RawIbSnapshot | undefined,
  contract: Contract | null,
  userId: string,
  entryInfo: EntryInfo,
): Promise<AssembledPosition> {
  const partial = ibPositionToPartial(raw);
  const bars = await todaysBars(partial.conid);
  const vwap = currentVwap(bars);
  const prevClose = snapNum(snap, '7296');
  const todayChange = prevClose != null ? partial.currentPrice - prevClose : null;
  const todayChangePct = todayChange != null && prevClose ? (todayChange / prevClose) * 100 : null;
  const costBasis = partial.shares * partial.avgCost;
  const unrealizedPnlPct = costBasis !== 0 ? (partial.unrealizedPnl / costBasis) * 100 : null;

  const daysHeld = tradingDaysHeld(new Date(entryInfo.firstSeenAt));
  const dailyReturn =
    unrealizedPnlPct != null && daysHeld > 0 ? unrealizedPnlPct / daysHeld : null;

  return {
    user_id: userId,
    conid: partial.conid,
    account_id: partial.accountId,
    symbol: partial.symbol,
    company_name: contract?.companyName ?? null,
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
    daily_return: dailyReturn,
    trading_days_held: daysHeld > 0 ? daysHeld : null,
    first_seen_at: entryInfo.firstSeenAt,
    first_seen_source: entryInfo.firstSeenSource,
    currency: partial.currency,
    asset_class: partial.assetClass,
    industry: contract?.industry ?? null,
    category: contract?.category ?? null,
    price_source: 'ib',
    last_price_update_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Zone fields are placeholders here — pollCycle recomputes the real
    // transition from the prior row + the user's threshold.
    zone_entered_at: null,
    zone_exited_at: null,
    last_zone_notification_at: null,
    entered_zone_via_gap: false,
  };
}

async function pollCycle(userId: string, accountId: string): Promise<void> {
  const rawPositions: RawIbPosition[] = await ibGateway.positions(accountId);
  // IB sometimes returns recently-closed positions with shares=0 for a while
  // after the close. They aren't holdings and they pollute downstream logic
  // (orphan check by symbol wouldn't catch them — same symbol, just no
  // shares). Filter at the source so they're treated as not-held, which makes
  // the orphan delete below clear them.
  const positions = rawPositions.filter((p) => Number(p.position ?? 0) !== 0);
  if (positions.length === 0) {
    // No positions: zero out any stale rows for this user.
    await positionsTableModule.deleteAllForUser(userId);
    return;
  }

  // Pull existing rows once — used for entry-date preservation, the
  // change-detection skip below, and prior profit-taking-zone state. On a read
  // error, degrade to empty (every position re-upserts) — the prior behavior.
  const existing = await positionsTableModule.getHoldingFactsForUser(userId).catch(() => []);

  const existingMap = new Map<string, (typeof existing)[number]>();
  for (const r of existing) existingMap.set(r.symbol, r);

  const threshold = await getProfitZoneThreshold(userId);
  const zoneNotifications: { symbol: string; pnlPct: number; viaGap: boolean }[] = [];

  const conids = positions.map((p) => p.conid);
  const snapshots = await ibGateway.snapshot(conids);
  const snapByConid = new Map<number, RawIbSnapshot>();
  for (const s of snapshots) snapByConid.set(s.conid, s);

  const assembled: AssembledPosition[] = [];
  for (const raw of positions) {
    const contract = await ensureContractCached(raw.conid, raw.contractDesc);
    const snap = snapByConid.get(raw.conid);
    const partial = ibPositionToPartial(raw);
    const existingRow = existingMap.get(partial.symbol);
    const entryInfo = await resolveEntryInfo(
      raw,
      accountId,
      existingRow?.firstSeenAt ?? null,
      existingRow?.firstSeenSource ?? null,
    );
    const a = await assemblePosition(raw, snap, contract, userId, entryInfo);
    // Recompute profit-taking-zone state from the prior row + new P&L (14c).
    const zone = computeZoneState(
      {
        zone_entered_at: existingRow?.zoneEnteredAt ?? null,
        zone_exited_at: existingRow?.zoneExitedAt ?? null,
        last_zone_notification_at: existingRow?.lastZoneNotificationAt ?? null,
        entered_zone_via_gap: Boolean(existingRow?.enteredZoneViaGap),
      },
      a.unrealized_pnl_pct,
      threshold,
    );
    a.zone_entered_at = zone.fields.zone_entered_at;
    a.zone_exited_at = zone.fields.zone_exited_at;
    a.last_zone_notification_at = zone.fields.last_zone_notification_at;
    a.entered_zone_via_gap = zone.fields.entered_zone_via_gap;
    if (zone.notify && a.unrealized_pnl_pct != null) {
      zoneNotifications.push({ symbol: a.symbol, pnlPct: a.unrealized_pnl_pct, viaGap: a.entered_zone_via_gap });
    }
    assembled.push(a);
  }

  // MTD: stamp the portfolio value at the start of each calendar month so
  // /api/portfolio/summary can compute month-to-date return. Fire-and-forget;
  // a Redis hiccup must not block the position write below.
  const portfolioTotal = assembled.reduce((acc, r) => acc + (r.market_value || 0), 0);
  void recordPortfolioValueForMtd(userId, portfolioTotal).catch((err) => {
    void notifyError('ibPricePoller.mtdCache', (err as Error).message ?? 'unknown', err);
  });

  const toUpsert: AssembledPosition[] = [];
  for (const r of assembled) {
    const e = existingMap.get(r.symbol);
    if (!e) { toUpsert.push(r); continue; }
    // change detection — the price/size fields users see ticking, PLUS entry
    // provenance. We MUST force an upsert when first_seen_source flips
    // (observed→ib_transactions) or first_seen_at resolves to an exact date:
    // that event doesn't move on its own, and when the market is closed IB's
    // snapshot price equals finnhub's last write, so no price field changes to
    // carry it through. Excluding it (as we used to) meant a freshly resolved
    // entry date was recomputed every cycle but never persisted, and the hourly
    // resolve-throttle then re-locked the row to 'observed'. Once
    // source='ib_transactions' the resolver short-circuits, so this fires at
    // most once per real resolution — no thrash. (trading_days_held +
    // daily_return derive from first_seen_at and ride along on the same write.)
    // Price/P&L moved to `quotes` (Batch X5) — the positions row only changes
    // on holding facts: vwap, shares/avg_cost, entry provenance, zone state.
    if (
      Number(e.vwapValue ?? NaN) !== (r.vwap_value ?? NaN)
      || Number(e.shares) !== r.shares
      || Number(e.avgCost) !== r.avg_cost
      || String(e.firstSeenSource ?? '') !== r.first_seen_source
      || String(e.firstSeenAt ?? '') !== String(r.first_seen_at ?? '')
      // Zone transitions can carry a write even when the price-derived fields
      // above round to the same value (e.g. the daily gap-badge set on entry).
      || String(e.zoneEnteredAt ?? '') !== String(r.zone_entered_at ?? '')
      || Boolean(e.enteredZoneViaGap) !== r.entered_zone_via_gap
    ) {
      toUpsert.push(r);
    }
  }

  // Fire zone-entry notifications regardless of whether the row landed in the
  // change-detected upsert set — a fresh entry always changes zone_entered_at,
  // so it'll be in toUpsert, but the ping is best-effort and independent.
  for (const z of zoneNotifications) {
    void notifyProfitZoneEntry({ symbol: z.symbol, pnlPct: z.pnlPct, thresholdPct: threshold, viaGap: z.viaGap });
  }

  if (toUpsert.length === 0) return;

  try {
    await positionsTableModule.upsertHoldings(toUpsert);
  } catch (e) {
    void notifyError('ibPricePoller.positions.upsert', (e as Error).message);
  }

  // Mirror held prices into the canonical `quotes` table (Batch A1). IB is
  // always authoritative when this poller runs, so `setCanonical` defaults true.
  await Promise.all(
    assembled.map((r) => {
      // today_open lives only in the IB snapshot (field 7295) — not persisted
      // to positions. Pull it here so quotes carries it for the stats-alert
      // engine (Batch B).
      const todayOpen = snapNum(snapByConid.get(r.conid), '7295');
      return upsertQuote({
        conid: r.conid,
        symbol: r.symbol,
        source: 'ib',
        price: r.current_price,
        todayChangePct: r.today_change_pct,
        todayOpen,
      });
    }),
  );

  // Delete rows for symbols no longer held.
  const heldSymbols = new Set(assembled.map((r) => r.symbol));
  const orphanSymbols = existing.filter((r) => !heldSymbols.has(r.symbol)).map((o) => o.symbol);
  if (orphanSymbols.length > 0) {
    await positionsTableModule.deleteOrphans(userId, orphanSymbols);
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
    const auth = await ibGateway.status().catch(() => ({ authenticated: false, connected: false }));
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
      void notifyError('ibPricePoller.cycle', (e as Error).message ?? 'unknown', e);
    }

    await sleep(intervalFor(marketPeriodAt()));
  }
}

export function startIbPricePoller(): void {
  if (running) return;
  running = true;
  stopRequested = false;
  console.log(
    `[ibPricePoller] starting; intervals: regular=${POLL_INTERVAL_REGULAR_MS}ms, ` +
    `extended=${POLL_INTERVAL_EXTENDED_MS}ms, closed=${POLL_INTERVAL_CLOSED_MS}ms`,
  );
  void loop().catch((e) => {
    void notifyCritical('ibPricePoller.loop.crashed', 'loop terminated unexpectedly', e);
    running = false;
  });
}

export function stopIbPricePoller(): void {
  stopRequested = true;
  running = false;
}
