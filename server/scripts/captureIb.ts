/**
 * Batch 7 — Raw IB Client Portal capture.
 *
 * Sweeps every IB Web API endpoint our backend code references and writes the
 * raw JSON response (or error) into `captures/` at repo root. One call per file.
 * Errors are recorded as `*.error.json` so we learn what doesn't work, not just
 * what does.
 *
 * Prereqs:
 *   1. IB Client Portal Gateway running locally on https://localhost:5000
 *      (see infra/clientportal.gw/README.md).
 *   2. You logged in via browser and approved 2FA — auth must be active.
 *
 * Run:
 *   pnpm --filter server exec tsx scripts/captureIb.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from 'node:https';
import axios, { type AxiosInstance, type AxiosResponse, isAxiosError } from 'axios';

const GATEWAY = process.env.CPG_URL ?? 'https://localhost:5000';
const CAPTURES_DIR = resolve(process.cwd(), '../captures');

// Self-signed cert from the gateway is expected on localhost — accept it.
const client: AxiosInstance = axios.create({
  baseURL: GATEWAY,
  timeout: 20_000,
  httpsAgent: new Agent({ rejectUnauthorized: false }),
  validateStatus: () => true,
});

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
}

function writeJson(filename: string, data: unknown): void {
  const path = resolve(CAPTURES_DIR, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  wrote ${filename}`);
}

interface CallResult {
  ok: boolean;
  status: number;
  data: unknown;
}

async function capture(
  method: 'GET' | 'POST',
  endpoint: string,
  params: Record<string, string | number> | undefined,
  fileSlug: string,
): Promise<CallResult> {
  const fileBase = `${safeSlug(fileSlug)}-${timestamp()}`;
  const meta = { method, endpoint, params: params ?? {}, capturedAt: new Date().toISOString() };

  try {
    let res: AxiosResponse;
    if (method === 'GET') {
      res = await client.get(endpoint, { params });
    } else {
      res = await client.post(endpoint, params ?? {});
    }
    const ok = res.status >= 200 && res.status < 300;
    const payload = { ...meta, status: res.status, response: res.data };
    writeJson(`${fileBase}${ok ? '' : '.error'}.json`, payload);
    return { ok, status: res.status, data: res.data };
  } catch (err) {
    const errorInfo = isAxiosError(err)
      ? { message: err.message, code: err.code, status: err.response?.status, data: err.response?.data }
      : { message: String(err) };
    writeJson(`${fileBase}.error.json`, { ...meta, error: errorInfo });
    return { ok: false, status: 0, data: errorInfo };
  }
}

async function main(): Promise<void> {
  mkdirSync(CAPTURES_DIR, { recursive: true });
  console.log(`Capturing to ${CAPTURES_DIR}\n`);

  // 1. Auth status — sanity check before anything else.
  console.log('[1/8] auth/status');
  const auth = await capture('GET', '/v1/api/iserver/auth/status', undefined, 'auth-status');
  if (!auth.ok) {
    console.error('Auth check failed — gateway is reachable but not authenticated.');
    console.error('Log in via https://localhost:5000 in your browser and re-run.');
    process.exit(1);
  }
  const authData = auth.data as { authenticated?: boolean; connected?: boolean };
  if (!authData.authenticated || !authData.connected) {
    console.error('Gateway returned authenticated=false. Re-login via browser and re-run.');
    process.exit(1);
  }

  // 2. Keepalive — useful early so any data calls don't trip on a stale session.
  console.log('[2/8] tickle');
  await capture('POST', '/v1/api/tickle', undefined, 'tickle');

  // 3. Accounts — discover the live account ID we'll use for portfolio calls.
  console.log('[3/8] iserver/accounts');
  const accountsRes = await capture('GET', '/v1/api/iserver/accounts', undefined, 'accounts');
  const accounts = (accountsRes.data as { accounts?: string[] })?.accounts ?? [];
  const acctId = accounts[0];
  if (!acctId) {
    console.error('No accounts returned. Capture stops here.');
    process.exit(1);
  }
  console.log(`  account: ${acctId}`);

  // 4. Positions.
  console.log('[4/8] portfolio positions');
  const positionsRes = await capture(
    'GET',
    `/v1/api/portfolio/${acctId}/positions/0`,
    undefined,
    `positions-${acctId}`,
  );
  const positions = Array.isArray(positionsRes.data) ? (positionsRes.data as Record<string, unknown>[]) : [];
  console.log(`  ${positions.length} positions`);

  // Extract (symbol, conid) pairs for the iteration steps below.
  // IB's positions response uses `contractDesc` or `ticker` for the human symbol
  // and `conid` for the contract id — we capture both raw so the gap analysis can verify.
  interface HeldRef { symbol: string; conid: number }
  const held: HeldRef[] = [];
  for (const p of positions) {
    const conidRaw = p.conid;
    const tickerRaw = p.ticker ?? p.contractDesc ?? p.symbol;
    const conid = typeof conidRaw === 'number' ? conidRaw : Number(conidRaw);
    const symbol = typeof tickerRaw === 'string' ? tickerRaw : String(tickerRaw ?? '');
    if (!Number.isFinite(conid) || !symbol) continue;
    held.push({ symbol, conid });
  }

  // 5. secdef/search per held symbol — round-trip for the conid resolution path
  //    our backend will need for symbol→conid lookups.
  console.log(`[5/8] secdef/search × ${held.length}`);
  for (const { symbol } of held) {
    await capture('GET', '/v1/api/iserver/secdef/search', { symbol }, `secdef-search-${symbol}`);
  }

  // 6. Contract info per conid.
  console.log(`[6/8] contract info × ${held.length}`);
  for (const { symbol, conid } of held) {
    await capture('GET', `/v1/api/iserver/contract/${conid}/info`, undefined, `contract-info-${symbol}-${conid}`);
  }

  // 7. Snapshot per conid. Field codes mirror server/src/services/ibGateway.ts:53.
  //    The gap analysis will tell us which codes are right and which we should change.
  console.log(`[7/8] marketdata snapshot × ${held.length}`);
  for (const { symbol, conid } of held) {
    await capture(
      'GET',
      '/v1/api/iserver/marketdata/snapshot',
      { conids: conid, fields: '31,55,84,86,87,88' },
      `snapshot-${symbol}-${conid}`,
    );
  }

  // 8. History at each FE timeframe. The mapping below mirrors the timeframes
  //    in client/src/components/TickerDetail/TimeframeBar.tsx (30m, 2h, 1D, 2D,
  //    1W, 1M, 3M, 1Y, 5Y, All) translated to IB's (period, bar) format.
  const timeframes: Array<{ label: string; period: string; bar: string }> = [
    { label: '30m', period: '1h',  bar: '1min' },
    { label: '2h',  period: '2h',  bar: '5mins' },
    { label: '1D',  period: '1d',  bar: '5mins' },
    { label: '2D',  period: '2d',  bar: '15mins' },
    { label: '1W',  period: '1w',  bar: '1h' },
    { label: '1M',  period: '1m',  bar: '1d' },
    { label: '3M',  period: '3m',  bar: '1d' },
    { label: '1Y',  period: '1y',  bar: '1d' },
    { label: '5Y',  period: '5y',  bar: '1w' },
    { label: 'All', period: 'max', bar: '1m' },
  ];
  console.log(`[8/8] marketdata history × ${held.length * timeframes.length}`);
  for (const { symbol, conid } of held) {
    for (const tf of timeframes) {
      await capture(
        'GET',
        '/v1/api/iserver/marketdata/history',
        { conid, period: tf.period, bar: tf.bar },
        `history-${symbol}-${conid}-${tf.label}`,
      );
    }
  }

  console.log('\nDone. Inspect captures/ — files prefixed with the endpoint name,');
  console.log('errors marked `.error.json`.');
}

main().catch((e) => {
  console.error('Unexpected failure:', e);
  process.exit(1);
});
