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

// Helper: API base URL for fetch calls to the BE. Set via VITE_API_URL.
export const API_URL = import.meta.env.VITE_API_URL ?? '';

export async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Convenience fetch wrapper for BE API calls — adds auth header automatically.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...(await authHeader()), ...(init.headers ?? {}) };
  return fetch(`${API_URL}${path}`, { ...init, headers });
}
