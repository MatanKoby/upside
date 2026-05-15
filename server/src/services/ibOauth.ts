// IBKR OAuth 1.0a Extended — request signing primitives.
//
// Port of the relevant pieces of Voyz/ibind's `ibind/oauth/oauth1a.py`
// (https://github.com/Voyz/ibind/blob/master/ibind/oauth/oauth1a.py) to
// TypeScript using Node's built-in crypto. Reference for the protocol itself:
// https://www.interactivebrokers.com/campus/ibkr-api-page/oauth-1-0a-extended/
//
// Flow summary:
//   1. Decrypt the IBKR-issued encrypted access-token-secret with our private
//      RSA encryption key → hex "prepend" used in two places below.
//   2. Generate a 256-bit DH random `a` and challenge `g^a mod p`.
//   3. Build an OAuth 1.0a Authorization header for POST <rest>/oauth/live_session_token,
//      RSA-SHA256-signed over a base string that has the prepend prefixed.
//      Server replies with a `diffie_hellman_response` (server's DH pub) and
//      a `live_session_token_signature`.
//   4. Derive LST = base64( HMAC-SHA1(shared_secret_be_bytes, prepend_bytes) )
//      where shared_secret = response^a mod p, encoded as Java-style positive
//      big-endian (with a leading 0 byte if the high bit of the top byte is set).
//   5. For every subsequent request, build an OAuth 1.0a Authorization header
//      HMAC-SHA256-signed with base64-decode(LST) as the HMAC key.
//
// This file intentionally has zero imports from the rest of the server — it's
// a pure signing utility usable from anywhere (e.g., the smoke script under
// server/scripts/oauthSmoke.ts).

import {
  createHmac,
  createSign,
  privateDecrypt,
  randomBytes,
  constants as cryptoConstants,
} from 'node:crypto';

export interface OAuthConfig {
  consumerKey: string;
  accessToken: string;
  /**
   * The IBKR-issued encrypted access token secret, base64-encoded as IBKR
   * delivers it. We decrypt this once at startup with `decryptAccessTokenSecret`
   * to get the hex "prepend" used in init signing + LST derivation.
   */
  accessTokenSecretEncryptedB64: string;
  /** PEM contents (string) of our private signing key (RSA). */
  signatureKeyPem: string;
  /** PEM contents (string) of our private encryption key (RSA). */
  encryptionKeyPem: string;
  /** Hex string of the DH prime (P), extracted from dhparam.pem. */
  dhPrimeHex: string;
  /** Defaults to 2 — matches IBKR's expected DH generator. */
  dhGenerator?: number;
  /** Defaults to 'limited_poa' — the standard realm for IBKR retail OAuth. */
  realm?: string;
  /** Defaults to 'https://api.ibkr.com/v1/api/'. Trailing slash mandatory. */
  restUrl?: string;
}

export const DEFAULT_REST_URL = 'https://api.ibkr.com/v1/api/';
const DEFAULT_REALM = 'limited_poa';
const DEFAULT_DH_GENERATOR = 2;

// ---------------------------------------------------------------------------
// Step 1: decrypt the encrypted access token secret to a hex string.
// ---------------------------------------------------------------------------
export function decryptAccessTokenSecret(
  encryptedB64: string,
  privateEncryptionKeyPem: string,
): string {
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const decrypted = privateDecrypt(
    {
      key: privateEncryptionKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    },
    encrypted,
  );
  return decrypted.toString('hex');
}

// ---------------------------------------------------------------------------
// Step 2: DH key pair.
// ---------------------------------------------------------------------------
export interface DhPair {
  /** Our random `a`, hex, no `0x` prefix. */
  dhRandomHex: string;
  /** g^a mod p, hex, no `0x` prefix — sent to IBKR as `diffie_hellman_challenge`. */
  dhChallengeHex: string;
}

export function generateDhPair(dhPrimeHex: string, dhGenerator = DEFAULT_DH_GENERATOR): DhPair {
  // 256 random bits per IBind. We use a fresh CSPRNG draw each init.
  const aBytes = randomBytes(32); // 32 bytes = 256 bits
  const a = BigInt('0x' + aBytes.toString('hex'));
  const p = BigInt('0x' + dhPrimeHex);
  const g = BigInt(dhGenerator);
  const challenge = modPow(g, a, p);
  return {
    dhRandomHex: a.toString(16),
    dhChallengeHex: challenge.toString(16),
  };
}

// ---------------------------------------------------------------------------
// Step 3: build the init Authorization header (RSA-SHA256 over base string,
// with the decrypted-access-token-secret-hex prepended to the base string).
// ---------------------------------------------------------------------------
export interface BuildInitHeaderArgs {
  config: OAuthConfig;
  /** Fully qualified URL of the live_session_token endpoint. */
  requestUrl: string;
  /** From `generateDhPair`. */
  dhChallengeHex: string;
  /** Decrypted-access-token-secret hex from `decryptAccessTokenSecret`. */
  accessTokenSecretHex: string;
  /** Optional override for tests; defaults to current time. */
  timestamp?: string;
  /** Optional override for tests; defaults to a fresh random nonce. */
  nonce?: string;
}

export function buildInitAuthHeader(args: BuildInitHeaderArgs): string {
  const realm = args.config.realm ?? DEFAULT_REALM;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.config.consumerKey,
    oauth_nonce: args.nonce ?? generateNonce(),
    oauth_signature_method: 'RSA-SHA256',
    oauth_timestamp: args.timestamp ?? generateTimestamp(),
    oauth_token: args.config.accessToken,
    diffie_hellman_challenge: args.dhChallengeHex,
  };

  const baseString = buildBaseString({
    method: 'POST',
    url: args.requestUrl,
    params: oauthParams,
    prepend: args.accessTokenSecretHex,
  });

  const signature = signRsaSha256(baseString, args.config.signatureKeyPem);
  oauthParams.oauth_signature = signature;

  return buildAuthorizationHeader(realm, oauthParams);
}

// ---------------------------------------------------------------------------
// Step 4: derive the Live Session Token from the server's DH response.
// ---------------------------------------------------------------------------
export function deriveLst(
  dhPrimeHex: string,
  dhRandomHex: string,
  dhResponseHex: string,
  accessTokenSecretHex: string,
): string {
  const p = BigInt('0x' + dhPrimeHex);
  const a = BigInt('0x' + dhRandomHex);
  const B = BigInt('0x' + dhResponseHex);

  // shared_secret = B^a mod p
  const sharedSecret = modPow(B, a, p);

  // Encode as Java-style positive big-endian — prepend a 0 byte if the top
  // byte's high bit would otherwise mark it as negative in two's-complement.
  // This matches IBind's `to_byte_array` behavior exactly.
  const sharedBytes = bigintToJavaBytes(sharedSecret);

  // The "prepend" (access token secret in hex form) is HMAC'd as raw bytes,
  // i.e. as if `Buffer.from(hexString, 'hex')`.
  const prependBytes = Buffer.from(accessTokenSecretHex, 'hex');

  // HMAC-SHA1 with shared_secret as KEY and prepend as MESSAGE.
  const hmac = createHmac('sha1', sharedBytes);
  hmac.update(prependBytes);
  return hmac.digest('base64');
}

// ---------------------------------------------------------------------------
// Step 5: build the per-request Authorization header for protected endpoints
// (HMAC-SHA256 keyed on base64-decoded LST).
// ---------------------------------------------------------------------------
export interface BuildRequestHeaderArgs {
  config: OAuthConfig;
  liveSessionToken: string;
  method: string;
  /** Fully qualified URL — including any query string for GETs. */
  url: string;
  /** Query parameters parsed out of the URL; included in the base string. */
  queryParams?: Record<string, string>;
  /** Optional override for tests; defaults to current time. */
  timestamp?: string;
  /** Optional override for tests; defaults to a fresh random nonce. */
  nonce?: string;
}

export function buildRequestAuthHeader(args: BuildRequestHeaderArgs): string {
  const realm = args.config.realm ?? DEFAULT_REALM;
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: args.config.consumerKey,
    oauth_nonce: args.nonce ?? generateNonce(),
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: args.timestamp ?? generateTimestamp(),
    oauth_token: args.config.accessToken,
  };

  // Strip the query string off the URL for the base string — query params are
  // merged in separately.
  const [urlNoQuery] = args.url.split('?');
  const allParams: Record<string, string> = { ...oauthParams, ...(args.queryParams ?? {}) };

  const baseString = buildBaseString({
    method: args.method.toUpperCase(),
    url: urlNoQuery ?? args.url,
    params: allParams,
  });

  const signature = signHmacSha256(baseString, args.liveSessionToken);
  oauthParams.oauth_signature = signature;

  return buildAuthorizationHeader(realm, oauthParams);
}

// ===========================================================================
// Internals
// ===========================================================================

function generateNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 16 chars per IBind. crypto.randomBytes(16) gives uniform bytes; mod 62
  // introduces a tiny bias but is fine for a nonce (only needs uniqueness).
  const raw = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[raw[i]! % alphabet.length];
  }
  return out;
}

function generateTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

interface BuildBaseStringArgs {
  method: string;
  url: string;
  params: Record<string, string>;
  /** Prefixed to the base string verbatim (for init signing). */
  prepend?: string;
}

function buildBaseString({ method, url, params, prepend }: BuildBaseStringArgs): string {
  // sort by key, lexicographic ASCII order
  const sortedKeys = Object.keys(params).sort();
  // join as "k1=v1&k2=v2" — no per-param encoding here; the whole string is
  // percent-encoded once below.
  const paramString = sortedKeys.map((k) => `${k}=${params[k]}`).join('&');
  const base = `${method}&${quotePlus(url)}&${quotePlus(paramString)}`;
  return prepend ? `${prepend}${base}` : base;
}

function signRsaSha256(baseString: string, privateSignatureKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(baseString, 'utf8');
  signer.end();
  const sigB64 = signer.sign(privateSignatureKeyPem, 'base64');
  // Match IBind: base64 sometimes has a trailing newline (some PEM tooling
  // does). Strip newlines then URL-encode the whole thing (quote_plus style).
  return quotePlus(sigB64.replace(/\n/g, ''));
}

function signHmacSha256(baseString: string, liveSessionTokenB64: string): string {
  const key = Buffer.from(liveSessionTokenB64, 'base64');
  const hmac = createHmac('sha256', key);
  hmac.update(baseString, 'utf8');
  const sigB64 = hmac.digest('base64');
  return quotePlus(sigB64);
}

function buildAuthorizationHeader(realm: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const kvs = sortedKeys.map((k) => `${k}="${params[k]}"`).join(', ');
  return `OAuth realm="${realm}", ${kvs}`;
}

/**
 * Python's urllib.parse.quote_plus equivalent:
 *  - A-Z a-z 0-9 - _ . ~  ⇒ unchanged
 *  - space ⇒ '+'
 *  - everything else ⇒ %HH (uppercase hex)
 *
 * Node's encodeURIComponent is RFC-3986-ish but leaves `!*'()` unescaped and
 * uses `%20` for spaces. We fix those two differences below.
 */
function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+');
}

/**
 * Modular exponentiation for BigInt (Node's BigInt doesn't ship it).
 * `base^exp mod m`. All inputs assumed positive.
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * Converts a positive BigInt to a big-endian byte buffer. If the high bit of
 * the top byte is set (i.e. the bit length is an exact multiple of 8), a
 * leading 0x00 byte is prepended — matching Java BigInteger's positive
 * two's-complement encoding, which is what IBind's `to_byte_array` produces
 * and what IBKR's server expects for the shared-secret HMAC key.
 */
function bigintToJavaBytes(n: bigint): Buffer {
  if (n === 0n) return Buffer.from([0]);
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const bytes = Buffer.from(hex, 'hex');
  // bitLength % 8 === 0 means top byte's high bit is set.
  const bitLength = n.toString(2).length;
  if (bitLength % 8 === 0) {
    return Buffer.concat([Buffer.from([0]), bytes]);
  }
  return bytes;
}
