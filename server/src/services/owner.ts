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
import { ibGateway } from '../adapters/ib/ibGatewayAdapter.js';

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
  // Account discovery via the gateway's /iserver/accounts (now an adapter
  // method — the inline axios call that read env.ibGatewayUrl here moved into
  // IbGatewayAdapter so the gateway has one door). Pick the selected account,
  // else the first.
  const { accounts, selectedAccount } = await ibGateway.accounts();
  const acct = selectedAccount ?? accounts[0] ?? null;
  if (!acct) {
    console.error('[owner] no IB account resolved from /iserver/accounts');
    return null;
  }
  _cachedAccountId = acct;
  console.log(`[owner] resolved IB account id: ${acct}`);
  return _cachedAccountId;
}

// Sanity helper used by pricePoller — confirms positions endpoint is reachable
// with the resolved account ID. Returns null on failure.
export async function probePositions(accountId: string): Promise<number | null> {
  try {
    const rows = await ibGateway.positions(accountId);
    return rows.length;
  } catch {
    return null;
  }
}
