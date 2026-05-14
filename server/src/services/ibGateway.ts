import axios, { type AxiosInstance } from 'axios';
import { env } from '../env.js';

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
    });
  }
  return _client;
}

export async function ibLogin(username: string, password: string): Promise<{ ok: boolean; session?: string; error?: string }> {
  await rateLimit();
  const res = await client().post('/v1/api/iserver/auth/ssodh/init', { username, password });
  if (res.status >= 200 && res.status < 300) {
    const session = res.data?.session ?? null;
    return { ok: true, session: session ?? undefined };
  }
  return { ok: false, error: `IB login failed (${res.status})` };
}

export async function ibTickle(): Promise<boolean> {
  await rateLimit();
  const res = await client().post('/v1/api/tickle');
  return res.status >= 200 && res.status < 300;
}

export async function ibStatus(): Promise<{ authenticated: boolean; connected: boolean }> {
  await rateLimit();
  const res = await client().get('/v1/api/iserver/auth/status');
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

export async function ibPositions(accountId: string): Promise<unknown[]> {
  await rateLimit();
  const res = await client().get(`/v1/api/portfolio/${accountId}/positions/0`);
  return Array.isArray(res.data) ? res.data : [];
}

export async function ibSnapshot(conids: number[]): Promise<unknown[]> {
  await rateLimit();
  const res = await client().get('/v1/api/iserver/marketdata/snapshot', {
    params: { conids: conids.join(','), fields: '31,55,84,86,87,88' },
  });
  return Array.isArray(res.data) ? res.data : [];
}

export async function ibHistory(conid: number, period: string, bar: string): Promise<unknown> {
  await rateLimit();
  const res = await client().get('/v1/api/iserver/marketdata/history', {
    params: { conid, period, bar },
  });
  return res.data;
}
