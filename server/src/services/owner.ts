// Resolves "whose data are we writing/reading?"
//
// MVP is single-user: pricePoller serves the first whitelisted email's
// Supabase user. We look that user up at startup and cache.
//
// Why first whitelisted email (not just "the only user"): we may have multiple
// emails in UPSIDE_ALLOWED_EMAILS (per spec — auth allows multi-user), but
// pricePoller only serves the first. Additional users can sign in but see
// empty data until multi-user infrastructure ships post-MVP.

import { env } from '../env.js';
import { supabase } from './supabase.js';
import { ibPositions } from './ibGateway.js';

let _cachedOwnerUserId: string | null = null;
let _cachedAccountId: string | null = null;

interface SupabaseAuthUser {
  id: string;
  email?: string | null;
}

export async function resolveOwnerUserId(): Promise<string | null> {
  if (_cachedOwnerUserId) return _cachedOwnerUserId;
  const targetEmail = env.allowedEmails[0];
  if (!targetEmail) {
    console.warn('[owner] UPSIDE_ALLOWED_EMAILS is empty; no owner to resolve');
    return null;
  }
  // supabase.auth.admin.listUsers returns server-side-only via service-role key.
  const { data, error } = await supabase().auth.admin.listUsers();
  if (error) {
    console.error('[owner] listUsers failed:', error.message);
    return null;
  }
  const users = (data?.users ?? []) as SupabaseAuthUser[];
  const match = users.find((u) => (u.email ?? '').toLowerCase() === targetEmail);
  if (!match) {
    console.warn(`[owner] no Supabase user yet for ${targetEmail}; waiting for first sign-in`);
    return null;
  }
  _cachedOwnerUserId = match.id;
  console.log(`[owner] resolved owner user_id for ${targetEmail}`);
  return _cachedOwnerUserId;
}

export async function resolveAccountId(): Promise<string | null> {
  if (_cachedAccountId) return _cachedAccountId;
  // Discover via the first row of /portfolio/<acct>/positions/0 (we don't have
  // acct yet) — actually we need /iserver/accounts. Use the wrapper.
  // For simplicity we discover by trying ibPositions with empty string —
  // doesn't work. Use a dedicated accounts call.
  //
  // Implementation note: ibGateway doesn't currently expose /iserver/accounts;
  // we hit it via the existing client. Inlining a one-shot call here to avoid
  // bloating ibGateway with another method just for this.
  try {
    const axios = (await import('axios')).default;
    const Agent = (await import('node:https')).Agent;
    const res = await axios.get<{ accounts?: string[]; selectedAccount?: string }>(
      `${env.ibGatewayUrl}/v1/api/iserver/accounts`,
      {
        timeout: 10_000,
        httpsAgent: new Agent({ rejectUnauthorized: false }),
        validateStatus: () => true,
      },
    );
    if (res.status < 200 || res.status >= 300) {
      console.error('[owner] /iserver/accounts returned', res.status);
      return null;
    }
    const acct = res.data?.selectedAccount ?? res.data?.accounts?.[0] ?? null;
    if (!acct) {
      console.error('[owner] no accounts returned');
      return null;
    }
    _cachedAccountId = acct;
    console.log(`[owner] resolved IB account id: ${acct}`);
    return _cachedAccountId;
  } catch (e) {
    console.error('[owner] account discovery failed:', (e as Error).message);
    return null;
  }
}

// Sanity helper used by pricePoller — confirms positions endpoint is reachable
// with the resolved account ID. Returns null on failure.
export async function probePositions(accountId: string): Promise<number | null> {
  try {
    const rows = await ibPositions(accountId);
    return rows.length;
  } catch {
    return null;
  }
}
