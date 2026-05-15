import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import https from 'node:https';
import { env } from '../env.js';
import { supabase } from './supabase.js';
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

// Wraps an IB call to record duration / retries / status into ib_api_metrics.
// Fire-and-forget on the metric insert so we don't block the hot path.
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
      .from('ib_api_metrics')
      .insert({
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        duration_ms: durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .then(() => undefined, (err) => console.error('[ib_metrics insert]', err?.message ?? err));
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
      .from('ib_api_metrics')
      .insert({
        endpoint: opts.endpoint,
        conid: opts.conid ?? null,
        duration_ms: durationMs,
        retries,
        status: lastStatus,
        succeeded,
      })
      .then(() => undefined, (err) => console.error('[ib_metrics insert]', err?.message ?? err));
  }
}

// ---------------------------------------------------------------------------
// Auth + session.
// ---------------------------------------------------------------------------
export async function ibLogin(username: string, password: string): Promise<{ ok: boolean; session?: string; error?: string }> {
  await rateLimit();
  const { data, status } = await instrumented(
    { endpoint: '/v1/api/iserver/auth/ssodh/init' },
    async () => {
      const res = await client().post<{ session?: string }>('/v1/api/iserver/auth/ssodh/init', { username, password });
      return { status: res.status, data: res.data };
    },
  );
  if (status >= 200 && status < 300) {
    return { ok: true, session: data?.session ?? undefined };
  }
  return { ok: false, error: `IB login failed (${status})` };
}

export async function ibTickle(): Promise<boolean> {
  await rateLimit();
  const { status } = await instrumented(
    { endpoint: '/v1/api/tickle' },
    async () => {
      const res = await client().post('/v1/api/tickle');
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300;
}

export async function ibStatus(): Promise<{ authenticated: boolean; connected: boolean }> {
  await rateLimit();
  const { data } = await instrumented(
    { endpoint: '/v1/api/iserver/auth/status' },
    async () => {
      const res = await client().get<{ authenticated?: boolean; connected?: boolean }>('/v1/api/iserver/auth/status');
      return { status: res.status, data: res.data };
    },
  );
  return {
    authenticated: !!data?.authenticated,
    connected: !!data?.connected,
  };
}

export async function ibLogout(): Promise<boolean> {
  await rateLimit();
  const { status } = await instrumented(
    { endpoint: '/v1/api/logout' },
    async () => {
      const res = await client().post('/v1/api/logout');
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300;
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
export async function ibContractInfo(conid: number): Promise<RawIbContractInfo | null> {
  await rateLimit();
  const { data, status } = await instrumented(
    { endpoint: '/v1/api/iserver/contract/<conid>/info', conid },
    async () => {
      const res = await client().get<RawIbContractInfo>(`/v1/api/iserver/contract/${conid}/info`);
      return { status: res.status, data: res.data };
    },
  );
  return status >= 200 && status < 300 ? data : null;
}

export async function ibSecdefSearch(symbol: string): Promise<RawIbSecdefResult[]> {
  await rateLimit();
  const { data } = await instrumented(
    { endpoint: '/v1/api/iserver/secdef/search' },
    async () => {
      const res = await client().get<RawIbSecdefResult[]>('/v1/api/iserver/secdef/search', {
        params: { symbol },
      });
      return { status: res.status, data: res.data };
    },
  );
  return Array.isArray(data) ? data : [];
}
