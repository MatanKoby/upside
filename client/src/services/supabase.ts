import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  // Surface clearly in dev. In production the build fails earlier without env vars.
  console.error(
    '[supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. ' +
    'Set them in .env (local) or Vercel project settings (deploy).'
  );
}

export const supabase: SupabaseClient = createClient(url ?? '', publishableKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Convenience fetch wrapper for BE API calls — adds auth header automatically
// and resolves the base URL from Supabase app_config (see ./apiUrl). On a
// network-class fetch failure, the cache is cleared and the call is retried
// once against a freshly-resolved URL — this is the FE half of the
// self-healing Quick Tunnel mechanism.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // Imported lazily to avoid an ESM cycle: apiUrl.ts imports `supabase` from
  // this module.
  const { getApiUrl, clearCachedApiUrl } = await import('./apiUrl');
  const headers = { ...(await authHeader()), ...(init.headers ?? {}) };
  const base = await getApiUrl();
  try {
    return await fetch(`${base}${path}`, { ...init, headers });
  } catch (e) {
    if (e instanceof TypeError) {
      // "Failed to fetch" — suggests the tunnel URL rotated. Refresh and retry once.
      console.warn('[apiFetch] network error, refreshing api url and retrying');
      clearCachedApiUrl();
      const fresh = await getApiUrl();
      return fetch(`${fresh}${path}`, { ...init, headers });
    }
    throw e;
  }
}
