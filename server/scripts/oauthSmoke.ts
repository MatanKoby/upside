/**
 * IBKR OAuth 1.0a smoke test — `oauth-dev` branch.
 *
 * Proves the full auth + data-fetch flow against IBKR's live Web API:
 *   1. Decrypt the access token secret using our private encryption key.
 *   2. Generate a DH key pair locally.
 *   3. POST /oauth/live_session_token with an RSA-SHA256-signed Authorization
 *      header; receive the server's DH response and LST signature.
 *   4. Derive the Live Session Token (LST) from the DH exchange and decrypted
 *      access token secret. Optionally validate it against the server's
 *      signature.
 *   5. POST /iserver/auth/ssodh/init to bootstrap the brokerage session.
 *   6. GET /portfolio/accounts → list of accounts.
 *   7. GET /portfolio/<acctId>/positions/0 → real positions.
 *   8. GET /iserver/marketdata/snapshot for the first position's conid.
 *
 * If this script runs end-to-end and prints actual data, the OAuth approach
 * is proven and we can plan integration into the rest of the stack.
 *
 * Prereqs:
 *   - IBKR has activated your consumer key (1-7+ days post-registration).
 *   - server/.env.oauth filled in with real values (gitignored).
 *   - Private keys (RSA signing, RSA encryption) on disk at the paths in env.
 *
 * Run:
 *   pnpm --filter server exec tsx scripts/oauthSmoke.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { Buffer } from 'node:buffer';
import axios, { isAxiosError } from 'axios';
import * as dotenv from 'dotenv';
import {
  type OAuthConfig,
  DEFAULT_REST_URL,
  buildInitAuthHeader,
  buildRequestAuthHeader,
  decryptAccessTokenSecret,
  deriveLst,
  generateDhPair,
} from '../src/services/ibOauth.js';

// Load the dedicated oauth env file, not the main .env.
dotenv.config({ path: resolve(process.cwd(), '.env.oauth') });

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    console.error(`Define it in server/.env.oauth.`);
    process.exit(1);
  }
  return v;
}

function readPem(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`Failed to read key at ${path}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

const config: OAuthConfig = {
  consumerKey: requireEnv('OAUTH_CONSUMER_KEY'),
  accessToken: requireEnv('OAUTH_ACCESS_TOKEN'),
  accessTokenSecretEncryptedB64: requireEnv('OAUTH_ACCESS_TOKEN_SECRET_ENCRYPTED'),
  signatureKeyPem: readPem(requireEnv('OAUTH_SIGNATURE_KEY_PATH')),
  encryptionKeyPem: readPem(requireEnv('OAUTH_ENCRYPTION_KEY_PATH')),
  dhPrimeHex: requireEnv('OAUTH_DH_PRIME').replace(/^0x/i, ''),
  realm: process.env.OAUTH_REALM ?? 'limited_poa',
  restUrl: process.env.OAUTH_REST_URL ?? DEFAULT_REST_URL,
};

const REST_URL = config.restUrl!;
const LST_PATH = 'oauth/live_session_token';

// Axios client — no custom auth, we sign per-request manually below.
const http = axios.create({
  baseURL: REST_URL,
  timeout: 20_000,
  // Don't throw on non-2xx — we want to inspect the bodies.
  validateStatus: () => true,
});

function logStep(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
  logStep('1. Decrypt access token secret');
  const accessTokenSecretHex = decryptAccessTokenSecret(
    config.accessTokenSecretEncryptedB64,
    config.encryptionKeyPem,
  );
  console.log(`Decrypted secret length: ${accessTokenSecretHex.length / 2} bytes`);

  logStep('2. Generate DH pair');
  const dh = generateDhPair(config.dhPrimeHex, config.dhGenerator ?? 2);
  console.log(`DH random  (first 16 hex): ${dh.dhRandomHex.slice(0, 16)}...`);
  console.log(`DH challenge (first 16 hex): ${dh.dhChallengeHex.slice(0, 16)}...`);

  logStep('3. POST live_session_token');
  const lstUrl = `${REST_URL}${LST_PATH}`;
  const initAuthHeader = buildInitAuthHeader({
    config,
    requestUrl: lstUrl,
    dhChallengeHex: dh.dhChallengeHex,
    accessTokenSecretHex,
  });

  const lstRes = await http.post(LST_PATH, undefined, {
    headers: {
      Authorization: initAuthHeader,
      Accept: '*/*',
      'User-Agent': 'upside-oauth-smoke/0.1',
      Host: 'api.ibkr.com',
    },
  });
  if (lstRes.status !== 200) {
    console.error(`live_session_token failed (${lstRes.status})`);
    console.error(lstRes.data);
    process.exit(1);
  }
  const { diffie_hellman_response, live_session_token_signature, live_session_token_expiration } =
    lstRes.data as {
      diffie_hellman_response: string;
      live_session_token_signature: string;
      live_session_token_expiration: number;
    };
  console.log(`LST expires at: ${new Date(live_session_token_expiration).toISOString()}`);

  logStep('4. Derive LST locally and validate');
  const lst = deriveLst(
    config.dhPrimeHex,
    dh.dhRandomHex,
    diffie_hellman_response,
    accessTokenSecretHex,
  );
  console.log(`LST (first 12): ${lst.slice(0, 12)}...`);

  // Validate: HMAC-SHA1(base64decode(LST), consumer_key) hex == server signature
  const lstValidation = createHmac('sha1', Buffer.from(lst, 'base64'))
    .update(config.consumerKey, 'utf8')
    .digest('hex');
  const lstValid = lstValidation === live_session_token_signature;
  console.log(`LST signature ${lstValid ? 'VALID ✓' : 'INVALID ✗'}`);
  if (!lstValid) {
    console.error('Expected:', live_session_token_signature);
    console.error('Got:     ', lstValidation);
    process.exit(1);
  }

  logStep('5. Bootstrap brokerage session');
  const ssoUrl = `${REST_URL}iserver/auth/ssodh/init`;
  const ssoBody = { compete: true, publish: true };
  const ssoAuth = buildRequestAuthHeader({
    config,
    liveSessionToken: lst,
    method: 'POST',
    url: ssoUrl,
  });
  const ssoRes = await http.post('iserver/auth/ssodh/init', ssoBody, {
    headers: { Authorization: ssoAuth, Accept: '*/*', 'User-Agent': 'upside-oauth-smoke/0.1' },
  });
  console.log(`ssodh/init status: ${ssoRes.status}`);
  console.log(`ssodh/init body:  ${JSON.stringify(ssoRes.data).slice(0, 200)}`);
  if (ssoRes.status >= 400) {
    console.error('ssodh/init failed — bailing.');
    process.exit(1);
  }

  logStep('6. GET /portfolio/accounts');
  const accountsUrl = `${REST_URL}portfolio/accounts`;
  const accountsAuth = buildRequestAuthHeader({
    config,
    liveSessionToken: lst,
    method: 'GET',
    url: accountsUrl,
  });
  const accountsRes = await http.get('portfolio/accounts', {
    headers: { Authorization: accountsAuth, Accept: '*/*', 'User-Agent': 'upside-oauth-smoke/0.1' },
  });
  console.log(`accounts status: ${accountsRes.status}`);
  if (accountsRes.status >= 400) {
    console.error(accountsRes.data);
    process.exit(1);
  }
  const accounts = accountsRes.data as Array<{ accountId: string; accountTitle?: string }>;
  console.log(
    `accounts:`,
    accounts.map((a) => ({ id: a.accountId, title: a.accountTitle })),
  );
  const acctId = accounts[0]?.accountId;
  if (!acctId) {
    console.error('No account returned — cannot continue.');
    process.exit(1);
  }

  logStep(`7. GET /portfolio/${acctId}/positions/0`);
  const positionsUrl = `${REST_URL}portfolio/${acctId}/positions/0`;
  const positionsAuth = buildRequestAuthHeader({
    config,
    liveSessionToken: lst,
    method: 'GET',
    url: positionsUrl,
  });
  const positionsRes = await http.get(`portfolio/${acctId}/positions/0`, {
    headers: { Authorization: positionsAuth, Accept: '*/*', 'User-Agent': 'upside-oauth-smoke/0.1' },
  });
  console.log(`positions status: ${positionsRes.status}`);
  if (positionsRes.status >= 400) {
    console.error(positionsRes.data);
    process.exit(1);
  }
  const positions = positionsRes.data as Array<{
    conid?: number;
    contractDesc?: string;
    position?: number;
    avgCost?: number;
    mktPrice?: number;
    unrealizedPnl?: number;
  }>;
  console.log(`positions count: ${positions.length}`);
  for (const p of positions.slice(0, 10)) {
    console.log(
      `  ${p.contractDesc ?? '(unknown)'}  conid=${p.conid}  qty=${p.position}  avg=${p.avgCost}  px=${p.mktPrice}  upnl=${p.unrealizedPnl}`,
    );
  }

  const firstConid = positions[0]?.conid;
  if (!firstConid) {
    console.log('\nNo positions to snapshot. All good up to this point.');
    return;
  }

  logStep(`8. GET /iserver/marketdata/snapshot for conid=${firstConid}`);
  // Same field codes as the existing ibGateway.ts uses.
  const fields = '31,70,71,82,83,84,86,87,7295,7296';
  const snapUrlNoQuery = `${REST_URL}iserver/marketdata/snapshot`;
  const snapQueryParams = { conids: String(firstConid), fields };
  const snapAuth = buildRequestAuthHeader({
    config,
    liveSessionToken: lst,
    method: 'GET',
    url: snapUrlNoQuery,
    queryParams: snapQueryParams,
  });
  const snapRes = await http.get('iserver/marketdata/snapshot', {
    params: snapQueryParams,
    headers: { Authorization: snapAuth, Accept: '*/*', 'User-Agent': 'upside-oauth-smoke/0.1' },
  });
  console.log(`snapshot status: ${snapRes.status}`);
  console.log(`snapshot body:  ${JSON.stringify(snapRes.data).slice(0, 400)}`);

  console.log('\n✓ Smoke complete. OAuth 1.0a end-to-end works.');
}

main().catch((e) => {
  if (isAxiosError(e)) {
    console.error('Axios error:', e.response?.status, e.response?.data ?? e.message);
  } else {
    console.error(e);
  }
  process.exit(1);
});
