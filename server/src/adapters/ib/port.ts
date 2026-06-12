// IbGatewayPort — the contract callers depend on for the IB Client Portal
// Gateway (the HTTP half). IbGatewayAdapter is the sole implementer and the
// sole importer of env.ibGatewayUrl. Vendor-shaped: one method per call we
// actually make against the gateway.
//
// Out of scope (stays a plain service): the container lifecycle in
// services/ibContainer.ts (docker start/stop — no env secret to gate) and the
// pure raw→domain mapping in services/ibMappers.ts. The pure entry-date
// deduction lives next door in ./entryDeduction.ts.
//
// See docs/arch/target-architecture.md → Phase 2.

import type {
  RawIbPosition,
  RawIbSnapshot,
  RawIbHistory,
  RawIbContractInfo,
  RawIbSecdefResult,
  RawIbWatchlistsResponse,
  RawIbWatchlistContents,
} from '../../types/index.js';

// --- vendor wire types (previously defined in services/ibGateway.ts) ---------

// POST /pa/transactions row — ~90 days, DAY-LEVEL only. `qty` is ALREADY SIGNED.
export interface RawIbTransaction {
  date?: string;
  rawDate?: string;
  cur?: string;
  pr?: number;
  qty?: number;
  amt?: number;
  fee?: number;
  type?: string;
  desc?: string;
  conid?: number;
  acctid?: string;
}

// GET /iserver/account/trades row — recent executions with intraday timestamps.
// `size` is unsigned; `side` is 'B'/'S'. ~7-day cap.
export interface RawIbTrade {
  conid?: number | string;
  side?: string;
  size?: number;
  trade_time_r?: number; // epoch ms
}

// Raw passthrough response (debug only) — the gateway's reply untouched so debug
// callers can inspect status, content-type, and body (incl. error bodies).
export interface IbRawResponse {
  status: number;
  contentType: string;
  data: unknown;
}

export interface IbGatewayPort {
  // --- auth + session (un-instrumented: hammered/rare, /healthz covers them) --
  tickle(): Promise<boolean>;
  status(): Promise<{ authenticated: boolean; connected: boolean }>;
  logout(): Promise<boolean>;
  accounts(): Promise<{ accounts: string[]; selectedAccount: string | null }>;

  // --- portfolio ------------------------------------------------------------
  positions(accountId: string): Promise<RawIbPosition[]>;
  transactions(acctId: string, conid: number, days?: number): Promise<RawIbTransaction[]>;
  trades(days?: number): Promise<RawIbTrade[]>;

  // --- market data ----------------------------------------------------------
  snapshot(conids: number[], requiredFields?: readonly string[]): Promise<RawIbSnapshot[]>;
  history(conid: number, period: string, bar: string): Promise<RawIbHistory | null>;

  // --- contract metadata + symbol resolution (un-instrumented) --------------
  contractInfo(conid: number): Promise<RawIbContractInfo | null>;
  secdefSearch(symbol: string): Promise<RawIbSecdefResult[]>;

  // --- watchlists -----------------------------------------------------------
  watchlists(): Promise<RawIbWatchlistsResponse | null>;
  watchlist(id: string): Promise<RawIbWatchlistContents | null>;

  // --- raw passthrough (debug only) -----------------------------------------
  rawGet(path: string, query?: Record<string, string | number | undefined>): Promise<IbRawResponse>;
  rawPost(path: string, body: unknown): Promise<IbRawResponse>;
}
