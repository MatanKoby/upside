// IbGatewayAdapter — the SOLE path of access to the IB Client Portal Gateway
// (the HTTP half) and the SOLE importer of env.ibGatewayUrl. Implements
// IbGatewayPort. Lifted out of services/ibGateway.ts (Batch ARCH-8); same
// endpoints, params, queueing, and field mapping — no behavior change.
//
// IB-specific quirks the base doesn't carry:
//   - **Self-signed cert.** The gateway ships a cert issued to `localhost`;
//     inside the compose network the host is `ib-gateway`, so verification is
//     disabled (traffic stays on the private bridge).
//   - **100ms rate limit.** Every call waits out a minimum inter-call gap.
//   - **Subscribe-then-poll snapshot.** IB's first snapshot reply only carries
//     `{ conid, conidEx }`; values appear on later polls — the retry loop bumps
//     the base's retry counter per re-poll.
//
// The timing → external_api_metrics → notifyApiFailure instrumentation that
// this file used to hand-roll (instrumented / instrumentedWithRetry) now lives
// in HttpAdapter.instrumented() (ARCH-8 8a): the retry counter, the
// `detail: "after N retries"` note, the debug-passthrough notify-skip, and the
// raw-body return all ride opt-in flags. Un-instrumented calls (auth/session,
// contract metadata) go through the base get()/post() directly, exactly as
// before (Batch 13.7 cleanup: hammered/rare calls with near-zero per-row value;
// reliability surfaces via /healthz + the Discord error notifier instead).
//
// See docs/arch/target-architecture.md → Phase 2.

import https from 'node:https';
import type { AxiosResponse } from 'axios';
import { HttpAdapter } from '../HttpAdapter.js';
import { env } from '../../env.js';
import type { IbGatewayPort, IbRawResponse, RawIbTransaction, RawIbTrade } from './port.js';
import type {
  RawIbPosition,
  RawIbSnapshot,
  RawIbHistory,
  RawIbContractInfo,
  RawIbSecdefResult,
  RawIbWatchlistsResponse,
  RawIbWatchlistContents,
} from '../../types/index.js';

const MIN_INTERVAL_MS = 100;

// Snapshot field codes (Batch 6 — verified against Batch 7 captures):
//   31 = last · 70 = today high · 71 = today low · 82 = chg% · 83 = chg$ ·
//   84 = bid · 86 = ask · 87 = volume · 7295 = open · 7296 = prior close
// VWAP intentionally absent — computed from intraday history.
const SNAPSHOT_FIELDS = '31,70,71,82,83,84,86,87,7295,7296';
const SNAPSHOT_POLL_INTERVAL_MS = 250;
const SNAPSHOT_MAX_ATTEMPTS = 8; // 8 × 250ms = 2s max wait

function isSnapshotPopulated(row: RawIbSnapshot | undefined, required?: readonly string[]): boolean {
  if (!row) return false;
  // Caller named the exact fields it needs (Batch X10.1): only "populated" once
  // every one is present + non-empty. IB streams fields incrementally, so the
  // default "any field present" check below bails too early and hands back a
  // row still missing, say, today's open (7295) or volume (87).
  if (required && required.length > 0) {
    const r = row as Record<string, unknown>;
    return required.every((f) => r[f] != null && r[f] !== '');
  }
  // Default: populated if any non-identifier field is present.
  for (const key of Object.keys(row)) {
    if (key === 'conid' || key === 'conidEx') continue;
    return true;
  }
  return false;
}

class IbGatewayAdapter extends HttpAdapter implements IbGatewayPort {
  private lastCallAt = 0;

  constructor() {
    super('ib', env.ibGatewayUrl, 15_000, {
      // Self-signed cert issued to `localhost`; the compose host is
      // `ib-gateway`. Traffic stays on the private bridge, so skip verification.
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }

  private async rateLimit(): Promise<void> {
    const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  // --- auth + session -------------------------------------------------------
  // No login: the gateway only accepts browser-mediated auth via its own UI
  // (proxied through the api's /ib-portal). These let the BE talk to that
  // session: tickle to keep alive, status to query, logout to terminate.
  async tickle(): Promise<boolean> {
    await this.rateLimit();
    const res = await this.post('/v1/api/tickle');
    return res.status >= 200 && res.status < 300;
  }

  async status(): Promise<{ authenticated: boolean; connected: boolean }> {
    await this.rateLimit();
    const res = await this.get<{ authenticated?: boolean; connected?: boolean }>(
      '/v1/api/iserver/auth/status',
    );
    return { authenticated: !!res.data?.authenticated, connected: !!res.data?.connected };
  }

  async logout(): Promise<boolean> {
    await this.rateLimit();
    const res = await this.post('/v1/api/logout');
    return res.status >= 200 && res.status < 300;
  }

  // Account discovery (cached by the caller). Was inlined in services/owner.ts
  // reading env.ibGatewayUrl directly — folded in here so the gateway has one
  // door. Un-instrumented like the rest of the session calls.
  async accounts(): Promise<{ accounts: string[]; selectedAccount: string | null }> {
    await this.rateLimit();
    const res = await this.get<{ accounts?: string[]; selectedAccount?: string }>(
      '/v1/api/iserver/accounts',
    );
    if (res.status < 200 || res.status >= 300) return { accounts: [], selectedAccount: null };
    return { accounts: res.data?.accounts ?? [], selectedAccount: res.data?.selectedAccount ?? null };
  }

  // --- portfolio ------------------------------------------------------------
  async positions(accountId: string): Promise<RawIbPosition[]> {
    await this.rateLimit();
    const { data } = await this.instrumented<RawIbPosition[]>({
      category: '/v1/api/portfolio/<acct>/positions/0', // account id redacted from the metric/notify key
      request: () => this.get<RawIbPosition[]>(`/v1/api/portfolio/${accountId}/positions/0`),
    });
    return Array.isArray(data) ? data : [];
  }

  async transactions(acctId: string, conid: number, days = 90): Promise<RawIbTransaction[]> {
    await this.rateLimit();
    const endpoint = '/v1/api/pa/transactions';
    // Body requirements, diagnosed live via the POST passthrough (Batch 13.5):
    // `acctIds`, `conids`, and `currency` are required (missing currency → 400),
    // and `days` is an optional numeric lookback (a STRING is rejected → 500).
    const body = { acctIds: [acctId], conids: [conid], currency: 'USD', days };
    const { data, status } = await this.instrumented<
      { transactions?: RawIbTransaction[] } | RawIbTransaction[]
    >({
      category: endpoint,
      conid,
      request: () => this.post(endpoint, body),
    });
    if (status < 200 || status >= 300) {
      // The error body now reaches Discord via the shared notify; log the status.
      console.warn(`[ibTransactions] conid=${conid} HTTP ${status}`);
      return [];
    }
    // IB returns either { transactions: [...] } or a bare array by version.
    if (Array.isArray(data)) return data;
    const arr = (data as { transactions?: RawIbTransaction[] } | null)?.transactions;
    return Array.isArray(arr) ? arr : [];
  }

  async trades(days = 7): Promise<RawIbTrade[]> {
    await this.rateLimit();
    const endpoint = '/v1/api/iserver/account/trades';
    const { data, status } = await this.instrumented<RawIbTrade[]>({
      category: endpoint,
      request: () => this.get(endpoint, { params: { days } }),
    });
    if (status < 200 || status >= 300) {
      console.warn(`[ibTrades] HTTP ${status}`);
      return [];
    }
    return Array.isArray(data) ? data : [];
  }

  // --- market data ----------------------------------------------------------
  async snapshot(conids: number[], requiredFields?: readonly string[]): Promise<RawIbSnapshot[]> {
    if (conids.length === 0) return [];
    const endpoint = '/v1/api/iserver/marketdata/snapshot';
    const { data } = await this.instrumented<RawIbSnapshot[]>({
      category: endpoint,
      conid: conids.length === 1 ? (conids[0] ?? null) : null,
      request: async (retry) => {
        let res: AxiosResponse<RawIbSnapshot[]> | undefined;
        for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
          await this.rateLimit();
          res = await this.get<RawIbSnapshot[]>(endpoint, {
            params: { conids: conids.join(','), fields: SNAPSHOT_FIELDS },
          });
          const arr = Array.isArray(res.data) ? res.data : [];
          const allPopulated =
            arr.length === conids.length && arr.every((r) => isSnapshotPopulated(r, requiredFields));
          if (allPopulated) return { ...res, data: arr };
          retry();
          await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
        }
        // Return what we have even if not fully populated — callers check.
        const finalArr = Array.isArray(res?.data) ? res.data : [];
        return res ? { ...res, data: finalArr } : ({ status: 0, data: finalArr } as AxiosResponse<RawIbSnapshot[]>);
      },
    });
    return data ?? [];
  }

  async history(conid: number, period: string, bar: string): Promise<RawIbHistory | null> {
    await this.rateLimit();
    const { data } = await this.instrumented<RawIbHistory>({
      category: '/v1/api/iserver/marketdata/history',
      conid,
      request: () =>
        this.get<RawIbHistory>('/v1/api/iserver/marketdata/history', { params: { conid, period, bar } }),
    });
    return data; // null on non-2xx (base maps it), the bundle on success
  }

  // --- contract metadata + symbol resolution (un-instrumented) --------------
  async contractInfo(conid: number): Promise<RawIbContractInfo | null> {
    await this.rateLimit();
    const res = await this.get<RawIbContractInfo>(`/v1/api/iserver/contract/${conid}/info`);
    return res.status >= 200 && res.status < 300 ? res.data : null;
  }

  async secdefSearch(symbol: string): Promise<RawIbSecdefResult[]> {
    await this.rateLimit();
    const res = await this.get<RawIbSecdefResult[]>('/v1/api/iserver/secdef/search', {
      params: { symbol },
    });
    return Array.isArray(res.data) ? res.data : [];
  }

  // --- watchlists -----------------------------------------------------------
  async watchlists(): Promise<RawIbWatchlistsResponse | null> {
    await this.rateLimit();
    const { data } = await this.instrumented<RawIbWatchlistsResponse>({
      category: '/v1/api/iserver/watchlists',
      request: () => this.get<RawIbWatchlistsResponse>('/v1/api/iserver/watchlists'),
    });
    return data;
  }

  async watchlist(id: string): Promise<RawIbWatchlistContents | null> {
    await this.rateLimit();
    const { data } = await this.instrumented<RawIbWatchlistContents>({
      category: '/v1/api/iserver/watchlist',
      request: () => this.get<RawIbWatchlistContents>('/v1/api/iserver/watchlist', { params: { id } }),
    });
    return data;
  }

  // --- raw passthrough (debug only — see routes/debug.ts) -------------------
  // Returns the gateway's response untouched (status/content-type/body) so debug
  // callers can inspect it. Tagged `debug-passthrough:<path>`, skips the Discord
  // notify (intentional probes, not errors), and returns the raw body even on a
  // non-2xx (rawData) so error responses are diagnosable.
  private async raw(path: string, exec: () => Promise<AxiosResponse>): Promise<IbRawResponse> {
    await this.rateLimit();
    let contentType = 'application/json';
    const { status, data } = await this.instrumented<unknown>({
      category: `debug-passthrough:${path}`,
      skipNotify: true,
      rawData: true,
      request: async () => {
        const res = await exec();
        contentType = (res.headers['content-type'] as string | undefined) ?? contentType;
        return res;
      },
    });
    return { status, data, contentType };
  }

  rawGet(path: string, query?: Record<string, string | number | undefined>): Promise<IbRawResponse> {
    return this.raw(path, () => this.get(path, { params: query }));
  }

  rawPost(path: string, body: unknown): Promise<IbRawResponse> {
    return this.raw(path, () => this.post(path, body));
  }
}

export const ibGateway: IbGatewayPort = new IbGatewayAdapter();
