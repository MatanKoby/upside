// Typed transformers between raw IB Client Portal Web API responses and our
// internal types. Lives at the boundary; downstream code (pricePoller, routes)
// only ever sees the normalized types, never raw IB.

import type {
  RawIbPosition,
  RawIbContractInfo,
  RawIbSnapshot,
  RawIbHistoryBar,
  RawIbHistory,
  RawIbSecdefResult,
  Contract,
  MarketSnapshot,
  OhlcBar,
  VwapPoint,
  HistoryBundle,
} from '../types/index.js';
import { vwap as computeVwap } from './technicals.js';

const EXCHANGE_PRIORITY = ['NYSE', 'NASDAQ', 'AMEX', 'SMART'] as const;

function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numOr(v: unknown, fallback: number): number {
  const n = num(v);
  return n ?? fallback;
}

// ---------------------------------------------------------------------------
// Contract — IB /contract/<conid>/info → cache row.
// ---------------------------------------------------------------------------
export function ibContractInfoToContract(raw: RawIbContractInfo): Contract {
  return {
    conid: raw.con_id,
    symbol: raw.symbol,
    companyName: raw.company_name,
    industry: raw.industry,
    category: raw.category,
    assetClass: raw.instrument_type ?? 'STK',
    currency: raw.currency ?? 'USD',
    exchange: raw.exchange,
    validExchanges: raw.valid_exchanges,
    refreshedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// MarketSnapshot — IB /marketdata/snapshot raw → normalized.
// Field codes per IB Web API docs (https://www.interactivebrokers.com/api/doc.html):
//   31    = last price          70    = today high       71    = today low
//   82    = today change %      83    = today change $   84    = bid
//   86    = ask                 87    = volume           7295  = open
//   7296  = prior close
// Codes verified against captures from Batch 7; re-verify on next capture
// after this code goes live.
// ---------------------------------------------------------------------------
export function ibSnapshotToMarketSnapshot(
  raw: RawIbSnapshot,
  symbol: string,
  vwapValue: number | null,
): MarketSnapshot {
  return {
    conid: raw.conid,
    symbol,
    price: numOr(raw['31'], 0),
    open: numOr(raw['7295'], 0),
    high: numOr(raw['70'], 0),
    low: numOr(raw['71'], 0),
    prevClose: numOr(raw['7296'], 0),
    bid: numOr(raw['84'], 0),
    ask: numOr(raw['86'], 0),
    volume: numOr(raw['87'], 0),
    vwap: vwapValue,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// History — IB /marketdata/history raw → typed bundle.
// Adds per-bar VWAP computed from the same bars (cheap, deterministic, avoids
// a second IB call).
// ---------------------------------------------------------------------------
export function ibHistoryToBundle(raw: RawIbHistory): HistoryBundle {
  const bars: OhlcBar[] = raw.data.map(ibBarToOhlc);
  const vwap: VwapPoint[] = perBarVwap(bars);
  return { bars, vwap };
}

export function ibBarToOhlc(raw: RawIbHistoryBar): OhlcBar {
  return { t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: raw.v };
}

// Per-bar cumulative VWAP — at bar i, VWAP includes bars [0..i].
// Resets implicitly by trading session because the history endpoint returns
// today's bars only when period=1d. For multi-day history this rolls over
// the entire window; callers wanting a per-session reset should pass single-day
// data.
function perBarVwap(bars: OhlcBar[]): VwapPoint[] {
  let cumPv = 0;
  let cumV = 0;
  const out: VwapPoint[] = [];
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    cumPv += typical * b.v;
    cumV += b.v;
    out.push({ t: b.t, v: cumV > 0 ? cumPv / cumV : typical });
  }
  return out;
}

// Convenience: compute the "current" scalar VWAP from a list of intraday bars.
// Used by pricePoller to populate `positions.vwap_value` each cycle.
export function currentVwap(bars: OhlcBar[]): number | null {
  if (bars.length === 0) return null;
  return computeVwap(
    bars.map((b) => b.h),
    bars.map((b) => b.l),
    bars.map((b) => b.c),
    bars.map((b) => b.v),
  );
}

// ---------------------------------------------------------------------------
// Position field extraction.
// pricePoller composes the final `Position` by combining:
//   1. The raw IB position (this function pulls the IB-side fields)
//   2. The contracts cache (industry, category, companyName)
//   3. The market snapshot (current price, today change, etc.)
//   4. Portfolio aggregates (weight, contribution)
// We don't try to do it all in one transformer because the inputs come from
// different IB calls at different times.
// ---------------------------------------------------------------------------
export interface PartialPositionFromIb {
  conid: number;
  accountId: string;
  symbol: string;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number | null;
  currency: string;
  assetClass: string;
}

export function ibPositionToPartial(raw: RawIbPosition): PartialPositionFromIb {
  return {
    conid: raw.conid,
    accountId: raw.acctId,
    symbol: raw.contractDesc,
    shares: raw.position,
    avgCost: raw.avgCost,
    currentPrice: raw.mktPrice,
    marketValue: raw.mktValue,
    unrealizedPnl: raw.unrealizedPnl,
    realizedPnl: raw.realizedPnl,
    currency: raw.currency,
    assetClass: raw.assetClass ?? 'STK',
  };
}

// ---------------------------------------------------------------------------
// secdef/search disambiguation.
// IB returns multiple matches per symbol (e.g. NYSE listing + Mexican listing).
// For MVP we trade on NYSE/NASDAQ — preference order:
//   NYSE → NASDAQ → AMEX → SMART → first remaining STK match
// Returns null if no STK section anywhere in the results (caller should
// surface this as a user-facing error).
// ---------------------------------------------------------------------------
export function pickPrimarySecdefResult(
  results: RawIbSecdefResult[],
): RawIbSecdefResult | null {
  const stkResults = results.filter((r) =>
    r.sections.some((s) => s.secType === 'STK'),
  );
  if (stkResults.length === 0) return null;

  for (const preferred of EXCHANGE_PRIORITY) {
    const match = stkResults.find((r) => r.description === preferred);
    if (match) return match;
  }
  return stkResults[0] ?? null;
}
