import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import https from 'node:https';
import { env } from '../env.js';
import { externalApiMetricsTableModule } from '../adapters/supabase/externalApiMetricsTableModule.js';
import { notifyApiFailure } from './notify.js';
import type {
  RawIbPosition,
  RawIbSnapshot,
  RawIbHistory,
  RawIbContractInfo,
  RawIbSecdefResult,
  RawIbWatchlistsResponse,
  RawIbWatchlistContents,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Rate limiting + instrumentation infrastructure.
// ---------------------------------------------------------------------------
const MIN_INTERVAL_MS = 100;
let lastCallAt = 0;

async function rateLimit(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

let _client: AxiosInstance | null = null;

function client(): AxiosInstance {
  if (!_client) {
    _client = axios.create({
      baseURL: env.ibGatewayUrl,
      timeout: 15_000,
      validateStatus: () => true,
      // IB Client Portal Gateway ships a self-signed cert issued to `localhost`.
      // Inside our compose network the hostname is `ib-gateway`, so the cert
      // can't validate. Traffic stays on the private bridge — never crosses
      // the host boundary — so disabling verification here is safe.
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }
  return _client;
}

interface InstrumentOpts {
  endpoint: string;
  conid?: number | null;
}

// Wraps an IB call to record duration / retries / status into
// external_api_metrics (provider: 'ib'). Fire-and-forget on the metric
// insert so we don't block the hot path.
async function instrumented<T>(
  opts: InstrumentOpts,
  fn: () => Promise<{ status: number; data: T }>,
): Promise<{ status: number; data: T; retries: number; durationMs: number }> {
  const start = performance.now();
  let retries = 0;
  let lastStatus = 0;
  let lastBody: unknown;
  let succeeded = false;
  try {
    const res = await fn();
    lastStatus = res.status;
    lastBody = res.data;
    succeeded = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      data: res.data,
      retries,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    const durationMs = Math.round(performance.now() - start);
    void externalApiMetricsTableModule
      .record({
        provider: 'ib',
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .catch((err) => console.error('[external_api_metrics insert]', err?.message ?? err));
    // Surface API error responses to Discord via the shared policy (suppresses
    // expected churn, rate-limited per endpoint). Without this, non-2xx
    // responses only ever reached the metrics table — Discord stayed blind.
    // Debug-passthrough probes are intentional experiments, not errors — skip.
    if (!opts.endpoint.startsWith('debug-passthrough:')) {
      notifyApiFailure(`ib_api.${opts.endpoint}`, lastStatus, {
        params: opts.conid != null ? { conid: opts.conid } : undefined,
        body: succeeded ? undefined : lastBody,
      });
    }
  }
}

// Variant of instrumented for calls that retry internally (e.g., snapshot).
// Lets the caller bump the retry counter from inside its retry loop.
interface RetryHandle {
  bump(): void;
}

async function instrumentedWithRetry<T>(
  opts: InstrumentOpts,
  fn: (h: RetryHandle) => Promise<{ status: number; data: T }>,
): Promise<{ status: number; data: T; retries: number; durationMs: number }> {
  const start = performance.now();
  let retries = 0;
  let lastStatus = 0;
  let lastBody: unknown;
  let succeeded = false;
  const h: RetryHandle = { bump: () => { retries++; } };
  try {
    const res = await fn(h);
    lastStatus = res.status;
    lastBody = res.data;
    succeeded = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      data: res.data,
      retries,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    const durationMs = Math.round(performance.now() - start);
    void externalApiMetricsTableModule
      .record({
        provider: 'ib',
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .catch((err) => console.error('[external_api_metrics insert]', err?.message ?? err));
    // Same Discord surfacing as instrumented() — fires once after all internal
    // retries (succeeded reflects the final attempt), so a flaky-then-recovered
    // call stays quiet. Debug-passthrough probes are excluded as above.
    if (!opts.endpoint.startsWith('debug-passthrough:')) {
      notifyApiFailure(`ib_api.${opts.endpoint}`, lastStatus, {
        detail: retries > 0 ? `after ${retries} retries` : undefined,
        params: opts.conid != null ? { conid: opts.conid } : undefined,
        body: succeeded ? undefined : lastBody,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Auth + session.
//
// No ibLogin function: the gateway only accepts browser-mediated auth via its
// own UI (programmatic POST to /v1/api/iserver/auth/ssodh/init returns 401).
// Users authenticate by loading the gateway's UI through the api's /ib-portal
// reverse proxy. The gateway holds the resulting session itself; the helpers
// below let our BE talk to that session (tickle to keep alive, status to
// query, logout to terminate).
// ---------------------------------------------------------------------------
// Not instrumented (Batch 13.7 cleanup): tickle is hammered every 30s with
// near-zero info value per row, /healthz already surfaces auth/status, and
// logout is rare + manual. Reliability problems with any of these surface
// via /healthz and the Discord error notifier — no concrete tuning lever
// reads these rows.
export async function ibTickle(): Promise<boolean> {
  await rateLimit();
  const res = await client().post('/v1/api/tickle');
  return res.status >= 200 && res.status < 300;
}

export async function ibStatus(): Promise<{ authenticated: boolean; connected: boolean }> {
  await rateLimit();
  const res = await client().get<{ authenticated?: boolean; connected?: boolean }>(
    '/v1/api/iserver/auth/status',
  );
  return {
    authenticated: !!res.data?.authenticated,
    connected: !!res.data?.connected,
  };
}

export async function ibLogout(): Promise<boolean> {
  await rateLimit();
  const res = await client().post('/v1/api/logout');
  return res.status >= 200 && res.status < 300;
}

// ---------------------------------------------------------------------------
// Portfolio.
// ---------------------------------------------------------------------------
export async function ibPositions(accountId: string): Promise<RawIbPosition[]> {
  await rateLimit();
  const { data } = await instrumented(
    { endpoint: `/v1/api/portfolio/<acct>/positions/0` },
    async () => {
      const res = await client().get<RawIbPosition[]>(`/v1/api/portfolio/${accountId}/positions/0`);
      return { status: res.status, data: res.data };
    },
  );
  return Array.isArray(data) ? data : [];
}

// ---------------------------------------------------------------------------
// Entry-date deduction (Batch 13.5) — two data sources, because neither alone
// is sufficient:
//
//  • /iserver/account/trades — per-execution INTRADAY timestamps (trade_time_r),
//    but only ~7 days of history. `size` is unsigned + a `side` ('B'/'S') field.
//    Catches a recent flatten + re-open (sell-to-0 then re-buy same day), which
//    is the *true* entry and which day-level data cannot see.
//  • POST /pa/transactions — ~90 days, but DAY-LEVEL only (dates are 00:00:00
//    and the array order is unreliable). `qty` is ALREADY SIGNED. Fallback for
//    positions whose entry predates the 7-day trades window.
//
// entryFromTrades() is tried first (intraday-accurate); entryFromTransactions()
// (day-level, order-independent) is the fallback. Inherent limit: an intraday
// flatten that happened >7 days ago is unrecoverable from IB.
// ---------------------------------------------------------------------------

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

export async function ibTransactions(
  acctId: string,
  conid: number,
  days = 90,
): Promise<RawIbTransaction[]> {
  await rateLimit();
  const endpoint = '/v1/api/pa/transactions';
  // Body requirements, diagnosed live via the POST passthrough (Batch 13.5):
  // `acctIds`, `conids`, and `currency` are required (missing currency → 400),
  // and `days` is an optional numeric lookback window — sending it as a STRING
  // is rejected with a 500. So: currency present, days numeric.
  const body = { acctIds: [acctId], conids: [conid], currency: 'USD', days };
  const { data, status } = await instrumented<{ transactions?: RawIbTransaction[] } | RawIbTransaction[]>(
    { endpoint, conid },
    async () => {
      const res = await client().post(endpoint, body);
      return { status: res.status, data: res.data };
    },
  );
  if (status < 200 || status >= 300) {
    // Surface the body so a future non-2xx is diagnosable rather than swallowed.
    console.warn(`[ibTransactions] conid=${conid} HTTP ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    return [];
  }
  // IB returns either { transactions: [...] } or a bare array depending on
  // version — accept both shapes.
  if (Array.isArray(data)) return data;
  const arr = (data as { transactions?: RawIbTransaction[] } | null)?.transactions;
  return Array.isArray(arr) ? arr : [];
}

// IB /iserver/account/trades — recent executions with intraday timestamps.
// `size` is unsigned; `side` is 'B'/'S'. Returns ALL of the account's trades
// for the window (every symbol); callers filter by conid. ~7-day cap (the
// `days` param does not extend it — verified live).
export interface RawIbTrade {
  conid?: number | string;
  side?: string;
  size?: number;
  trade_time_r?: number; // epoch ms
}

export async function ibTrades(days = 7): Promise<RawIbTrade[]> {
  await rateLimit();
  const endpoint = '/v1/api/iserver/account/trades';
  const { data, status } = await instrumented<RawIbTrade[]>(
    { endpoint },
    async () => {
      const res = await client().get(endpoint, { params: { days } });
      return { status: res.status, data: res.data };
    },
  );
  if (status < 200 || status >= 300) {
    console.warn(`[ibTrades] HTTP ${status}`);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/**
 * Intraday-accurate entry from the ~7-day trades window. Back-computes the
 * share balance just before the window (currentShares − Σ window fills for the
 * conid), then walks the conid's fills in execution-time order, returning the
 * timestamp of the most recent 0→positive crossing (a re-open). Returns null
 * when the position was already open before the window and never flattened in
 * it — i.e. the entry predates the trades window, so the caller falls back to
 * day-level transactions.
 */
export function entryFromTrades(
  trades: RawIbTrade[],
  conid: number,
  currentShares: number,
): Date | null {
  const fills = trades
    .filter((t) => Number(t.conid) === conid && typeof t.trade_time_r === 'number')
    .map((t) => {
      const size = typeof t.size === 'number' ? t.size : 0;
      const side = (t.side ?? '').toUpperCase();
      return { timeMs: t.trade_time_r as number, signed: side === 'S' ? -size : size };
    })
    .sort((a, b) => a.timeMs - b.timeMs);
  if (fills.length === 0) return null;

  const windowNet = fills.reduce((sum, f) => sum + f.signed, 0);
  let running = currentShares - windowNet; // balance just before the window
  let entry: Date | null = null;
  for (const f of fills) {
    const prev = running;
    running += f.signed;
    if (prev <= 0 && running > 0) entry = new Date(f.timeMs);
    if (running <= 0) entry = null;
  }
  return entry; // null ⇒ no flatten/re-open inside the window ⇒ entry is older
}

/**
 * Day-level fallback entry from /pa/transactions: aggregate net signed `qty`
 * per calendar day, walk end-of-day balances, return the most recent day the
 * balance crossed 0→positive. Order-independent (robust to IB's unreliable
 * same-day ordering) but blind to intraday flattens — used only for entries
 * older than the ~7-day trades window, where intraday data no longer exists.
 * Returns null if the 90-day window doesn't reconcile to currentShares.
 */
export function entryFromTransactions(
  transactions: RawIbTransaction[],
  currentShares: number,
): Date | null {
  const byDay = new Map<string, { date: Date; net: number }>();
  for (const tx of transactions) {
    if (!tx.date) continue;
    if (tx.type) {
      const t = tx.type.toLowerCase();
      if (!t.includes('buy') && !t.includes('sell')) continue; // skip non-trades
    }
    const d = new Date(tx.date);
    if (Number.isNaN(d.getTime())) continue;
    const key = tx.rawDate ?? tx.date;
    const qty = typeof tx.qty === 'number' ? tx.qty : 0; // pa `qty` is pre-signed
    const cur = byDay.get(key) ?? { date: d, net: 0 };
    cur.net += qty;
    byDay.set(key, cur);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  let running = 0;
  let entry: Date | null = null;
  for (const day of days) {
    const prev = running;
    running += day.net;
    if (prev <= 0 && running > 0) entry = day.date;
    if (running <= 0) entry = null;
  }
  if (Math.abs(running - currentShares) > 0.0001) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// Market data.
//
// SNAPSHOT — subscribe-then-poll pattern. IB's first response only contains
// `{ conid, conidEx }`; field values appear on subsequent calls once IB's
// server has warmed the subscription (typically 200-500ms later).
//
// Field codes (Batch 6 — verified against Batch 7 captures, but re-capture
// after this lands to confirm values populate as expected):
//   31    = last price
//   70    = today high
//   71    = today low
//   82    = today change %
//   83    = today change $
//   84    = bid
//   86    = ask
//   87    = volume
//   7295  = open
//   7296  = prior close
// VWAP intentionally not in this list — we compute it from intraday history.
// ---------------------------------------------------------------------------
const SNAPSHOT_FIELDS = '31,70,71,82,83,84,86,87,7295,7296';
const SNAPSHOT_POLL_INTERVAL_MS = 250;
const SNAPSHOT_MAX_ATTEMPTS = 8;     // 8 × 250ms = 2s max wait

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

export async function ibSnapshot(
  conids: number[],
  requiredFields?: readonly string[],
): Promise<RawIbSnapshot[]> {
  if (conids.length === 0) return [];
  const endpoint = '/v1/api/iserver/marketdata/snapshot';
  const { data } = await instrumentedWithRetry(
    { endpoint, conid: conids.length === 1 ? (conids[0] ?? null) : null },
    async (h) => {
      let res: AxiosResponse<RawIbSnapshot[]> | undefined;
      for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt++) {
        await rateLimit();
        res = await client().get<RawIbSnapshot[]>(endpoint, {
          params: { conids: conids.join(','), fields: SNAPSHOT_FIELDS },
        });
        const arr = Array.isArray(res.data) ? res.data : [];
        const allPopulated =
          arr.length === conids.length && arr.every((r) => isSnapshotPopulated(r, requiredFields));
        if (allPopulated) {
          return { status: res.status, data: arr };
        }
        h.bump();
        await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_INTERVAL_MS));
      }
      // Return what we have even if not fully populated — callers check.
      const finalArr = Array.isArray(res?.data) ? res.data : [];
      return { status: res?.status ?? 0, data: finalArr };
    },
  );
  return data;
}

export async function ibHistory(conid: number, period: string, bar: string): Promise<RawIbHistory | null> {
  await rateLimit();
  const { data, status } = await instrumented(
    { endpoint: '/v1/api/iserver/marketdata/history', conid },
    async () => {
      const res = await client().get<RawIbHistory>('/v1/api/iserver/marketdata/history', {
        params: { conid, period, bar },
      });
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300 ? data : null;
}

// ---------------------------------------------------------------------------
// Contract metadata + symbol resolution.
// ---------------------------------------------------------------------------
// Not instrumented (Batch 13.7 cleanup): contract info is lazy + weekly
// refresh, secdef search is rare. Whatever cache-tuning question we'd ask
// can be answered by querying the contracts table directly.
export async function ibContractInfo(conid: number): Promise<RawIbContractInfo | null> {
  await rateLimit();
  const res = await client().get<RawIbContractInfo>(`/v1/api/iserver/contract/${conid}/info`);
  return res.status >= 200 && res.status < 300 ? res.data : null;
}

export async function ibSecdefSearch(symbol: string): Promise<RawIbSecdefResult[]> {
  await rateLimit();
  const res = await client().get<RawIbSecdefResult[]>('/v1/api/iserver/secdef/search', {
    params: { symbol },
  });
  return Array.isArray(res.data) ? res.data : [];
}

// ---------------------------------------------------------------------------
// Watchlists (Batch A1) — IB user_lists + system_lists catalog and per-list
// contents. We persist user_lists only; system_lists are read-only IB-curated
// (e.g. "US Indices and ETFs"). Payload shapes verified via Batch 13.2
// captures under `captures/iserver/`.
// ---------------------------------------------------------------------------

export async function ibWatchlists(): Promise<RawIbWatchlistsResponse | null> {
  await rateLimit();
  const { data, status } = await instrumented(
    { endpoint: '/v1/api/iserver/watchlists' },
    async () => {
      const res = await client().get<RawIbWatchlistsResponse>('/v1/api/iserver/watchlists');
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300 ? data : null;
}

export async function ibWatchlist(id: string): Promise<RawIbWatchlistContents | null> {
  await rateLimit();
  const { data, status } = await instrumented(
    { endpoint: '/v1/api/iserver/watchlist' },
    async () => {
      const res = await client().get<RawIbWatchlistContents>('/v1/api/iserver/watchlist', {
        params: { id },
      });
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300 ? data : null;
}

// ---------------------------------------------------------------------------
// Raw passthrough (debug only — see server/src/routes/debug.ts).
//
// Returns the gateway's response untouched so debug callers can inspect
// status, headers, and body. Caller is responsible for path-allowlisting.
// Instrumented with a `debug-passthrough:<path>` endpoint tag so the audit
// log distinguishes passthrough calls from production code paths.
// ---------------------------------------------------------------------------
export interface IbRawResponse {
  status: number;
  contentType: string;
  data: unknown;
}

// Shared core for the debug passthrough (GET + POST). Issues the request via
// `exec`, preserves IB's content-type, and tags the metric as a passthrough so
// debug probes are excluded from Discord error notifications (see instrumented).
async function ibRaw(path: string, exec: () => Promise<AxiosResponse>): Promise<IbRawResponse> {
  await rateLimit();
  let contentType = 'application/json';
  const { status, data } = await instrumented<unknown>(
    { endpoint: `debug-passthrough:${path}` },
    async () => {
      const res = await exec();
      contentType = (res.headers['content-type'] as string | undefined) ?? contentType;
      return { status: res.status, data: res.data };
    },
  );
  return { status, data, contentType };
}

export function ibRawGet(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<IbRawResponse> {
  return ibRaw(path, () => client().get(path, { params: query }));
}

export function ibRawPost(path: string, body: unknown): Promise<IbRawResponse> {
  return ibRaw(path, () => client().post(path, body));
}
