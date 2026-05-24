import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import https from 'node:https';
import { env } from '../env.js';
import { supabase } from './supabase.js';
import { notifyApiFailure } from './notify.js';
import type {
  RawIbPosition,
  RawIbSnapshot,
  RawIbHistory,
  RawIbContractInfo,
  RawIbSecdefResult,
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
  let succeeded = false;
  try {
    const res = await fn();
    lastStatus = res.status;
    succeeded = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      data: res.data,
      retries,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    const durationMs = Math.round(performance.now() - start);
    void supabase()
      .from('external_api_metrics')
      .insert({
        provider: 'ib',
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        duration_ms: durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .then(() => undefined, (err) => console.error('[external_api_metrics insert]', err?.message ?? err));
    // Surface API error responses to Discord via the shared policy (suppresses
    // expected churn, rate-limited per endpoint). Without this, non-2xx
    // responses only ever reached the metrics table — Discord stayed blind.
    // Debug-passthrough probes are intentional experiments, not errors — skip.
    if (!opts.endpoint.startsWith('debug-passthrough:')) {
      notifyApiFailure(`ib_api.${opts.endpoint}`, lastStatus, opts.conid != null ? `conid=${opts.conid}` : '');
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
  let succeeded = false;
  const h: RetryHandle = { bump: () => { retries++; } };
  try {
    const res = await fn(h);
    lastStatus = res.status;
    succeeded = res.status >= 200 && res.status < 300;
    return {
      status: res.status,
      data: res.data,
      retries,
      durationMs: Math.round(performance.now() - start),
    };
  } finally {
    const durationMs = Math.round(performance.now() - start);
    void supabase()
      .from('external_api_metrics')
      .insert({
        provider: 'ib',
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        duration_ms: durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .then(() => undefined, (err) => console.error('[external_api_metrics insert]', err?.message ?? err));
    // Same Discord surfacing as instrumented() — fires once after all internal
    // retries (succeeded reflects the final attempt), so a flaky-then-recovered
    // call stays quiet. Debug-passthrough probes are excluded as above.
    if (!opts.endpoint.startsWith('debug-passthrough:')) {
      notifyApiFailure(
        `ib_api.${opts.endpoint}`,
        lastStatus,
        `${retries > 0 ? `after ${retries} retries ` : ''}${opts.conid != null ? `conid=${opts.conid}` : ''}`.trim(),
      );
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
// Transactions (Batch 13.5).
//
// POST /v1/api/pa/transactions with body { acctIds, conids, days }. Used by
// ibPricePoller to deduce a position's true entry date on first sight, by
// walking the user's last ~90 days of fills for the most recent 0→non-zero
// share-balance transition (the true open of the currently-held position).
//
// IB returns dates in a "Sat Mar 22 00:00:00 EDT 2026" string format which
// `new Date()` parses natively. Quantities arrive as unsigned `qty` plus a
// `type` field ("Buy" / "Sell" / "Dividend" / ...); deduceEntryDate signs
// them itself and walks the running balance.
// ---------------------------------------------------------------------------

export interface RawIbTransaction {
  date?: string;
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
  const endpoint = '/v1/api/pa/transactions';
  // Two IB quirks, both observed live in Batch 13.5:
  //  1. The body requires `currency`, and `days` must be a string — omitting
  //     currency or sending a numeric `days` is rejected with HTTP 400.
  //  2. The PortfolioAnalyst backend cold-starts: the first POST after the
  //     module is idle returns HTTP 500 with an *empty* body, then succeeds
  //     once warmed. So retry a few times before giving up.
  const body = { acctIds: [acctId], conids: [conid], currency: 'USD', days: String(days) };
  const MAX_ATTEMPTS = 4;
  const RETRY_MS = 1000;
  const { data, status } = await instrumentedWithRetry<{ transactions?: RawIbTransaction[] } | RawIbTransaction[]>(
    { endpoint, conid },
    async (h) => {
      let last: AxiosResponse | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await rateLimit();
        const res = await client().post(endpoint, body);
        last = res;
        if (res.status >= 200 && res.status < 300) {
          return { status: res.status, data: res.data };
        }
        // Log each non-2xx so a persistent failure (vs. cold-start) is visible.
        console.warn(
          `[ibTransactions] conid=${conid} attempt ${attempt + 1}/${MAX_ATTEMPTS} HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
        );
        h.bump();
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
      return { status: last?.status ?? 0, data: last?.data ?? [] };
    },
  );
  if (status < 200 || status >= 300) return [];
  // IB has historically returned either { transactions: [...] } or a bare
  // array depending on version — accept both shapes.
  if (Array.isArray(data)) return data;
  const arr = (data as { transactions?: RawIbTransaction[] } | null)?.transactions;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Walk a conid's transaction history chronologically and return the date of
 * the most recent 0→non-zero share-balance transition — the "true entry" of
 * the position currently held. Returns null if the window doesn't include
 * the entry (running sum after the walk doesn't match `currentShares`,
 * meaning earlier fills happened before the window) — caller should fall
 * back to the observation timestamp.
 */
export function deduceEntryDate(
  transactions: RawIbTransaction[],
  currentShares: number,
): Date | null {
  const events = transactions
    .map((tx) => {
      const d = tx.date ? new Date(tx.date) : null;
      if (!d || Number.isNaN(d.getTime())) return null;
      const qty = typeof tx.qty === 'number' ? tx.qty : 0;
      // Sign by `type` (preferred — IB returns positive qty + a side field).
      // Fall back to `amt` sign as a defensive proxy: buys debit cash (amt<0),
      // sells credit cash (amt>0).
      let signed = 0;
      if (tx.type) {
        const t = tx.type.toLowerCase();
        if (t.includes('buy')) signed = qty;
        else if (t.includes('sell')) signed = -qty;
        else return null;        // skip dividends, fees, journal entries, etc.
      } else if (typeof tx.amt === 'number') {
        signed = tx.amt < 0 ? qty : -qty;
      } else {
        return null;
      }
      return { date: d, qty: signed };
    })
    .filter((e): e is { date: Date; qty: number } => e !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  let running = 0;
  let entryDate: Date | null = null;
  for (const e of events) {
    const prev = running;
    running += e.qty;
    if (prev <= 0 && running > 0) entryDate = e.date;
    if (running <= 0) entryDate = null;
  }
  // Sanity: deduced final balance must match IB-reported current shares.
  // Allow a tiny epsilon for fractional-share float drift.
  if (Math.abs(running - currentShares) > 0.0001) return null;
  return entryDate;
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

function isSnapshotPopulated(row: RawIbSnapshot | undefined): boolean {
  if (!row) return false;
  // Consider populated if any non-identifier field is present.
  for (const key of Object.keys(row)) {
    if (key === 'conid' || key === 'conidEx') continue;
    return true;
  }
  return false;
}

export async function ibSnapshot(conids: number[]): Promise<RawIbSnapshot[]> {
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
        const allPopulated = arr.length === conids.length && arr.every(isSnapshotPopulated);
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
