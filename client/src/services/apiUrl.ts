import { supabase } from './supabase';

// Discovers the api + IB-portal public URLs from Supabase app_config and
// keeps in-memory + localStorage caches fresh via a Realtime subscription.
// Both URLs are written by the BE tunnel watcher (one per cloudflared
// service). Architecture: UPSIDE_MVP_SPEC.md → "Public URL Discovery" and
// "IB Authentication Flow".

const STORAGE_KEY_API = 'upside_api_url';
const STORAGE_KEY_IB_PORTAL = 'upside_ib_portal_url';

let inMemoryApiUrl: string | null = null;
let inMemoryIbPortalUrl: string | null = null;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, url: string): void {
  try {
    localStorage.setItem(key, url);
  } catch {
    // localStorage unavailable (private mode) — in-memory cache still works.
  }
}

function clearStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

async function fetchConfig(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load ${key} from Supabase: ${error.message}`);
  }
  return data?.value ?? null;
}

export async function getApiUrl(): Promise<string> {
  if (inMemoryApiUrl) return inMemoryApiUrl;
  const cached = readStorage(STORAGE_KEY_API);
  if (cached) {
    inMemoryApiUrl = cached;
    return cached;
  }
  const fetched = await fetchConfig('api_url');
  if (!fetched) {
    throw new Error(
      'app_config.api_url not yet populated. Ensure the BE tunnel watcher has run at least once.',
    );
  }
  inMemoryApiUrl = fetched;
  writeStorage(STORAGE_KEY_API, fetched);
  return fetched;
}

export async function getIbPortalUrl(): Promise<string> {
  if (inMemoryIbPortalUrl) return inMemoryIbPortalUrl;
  const cached = readStorage(STORAGE_KEY_IB_PORTAL);
  if (cached) {
    inMemoryIbPortalUrl = cached;
    return cached;
  }
  const fetched = await fetchConfig('ib_portal_url');
  if (!fetched) {
    throw new Error(
      'app_config.ib_portal_url not yet populated. Ensure the IB tunnel watcher has run at least once.',
    );
  }
  inMemoryIbPortalUrl = fetched;
  writeStorage(STORAGE_KEY_IB_PORTAL, fetched);
  return fetched;
}

export function clearCachedApiUrl(): void {
  inMemoryApiUrl = null;
  clearStorage(STORAGE_KEY_API);
}

export function clearCachedIbPortalUrl(): void {
  inMemoryIbPortalUrl = null;
  clearStorage(STORAGE_KEY_IB_PORTAL);
}

// Subscribes to Supabase Realtime on app_config for both keys we care about.
// Call once at app mount; the returned function tears down the subscription.
export function subscribeToApiUrl(): () => void {
  const applyApi = (next: unknown): void => {
    if (typeof next !== 'string') return;
    if (next === inMemoryApiUrl) return;
    console.log(`[apiUrl] api_url update: ${inMemoryApiUrl ?? '(none)'} -> ${next}`);
    inMemoryApiUrl = next;
    writeStorage(STORAGE_KEY_API, next);
  };
  const applyIbPortal = (next: unknown): void => {
    if (typeof next !== 'string') return;
    if (next === inMemoryIbPortalUrl) return;
    console.log(`[apiUrl] ib_portal_url update: ${inMemoryIbPortalUrl ?? '(none)'} -> ${next}`);
    inMemoryIbPortalUrl = next;
    writeStorage(STORAGE_KEY_IB_PORTAL, next);
  };

  const channel = supabase
    .channel('app_config_urls')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'app_config', filter: 'key=eq.api_url' },
      (payload) => applyApi((payload.new as { value?: unknown })?.value),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'app_config', filter: 'key=eq.api_url' },
      (payload) => applyApi((payload.new as { value?: unknown })?.value),
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'app_config', filter: 'key=eq.ib_portal_url' },
      (payload) => applyIbPortal((payload.new as { value?: unknown })?.value),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'app_config', filter: 'key=eq.ib_portal_url' },
      (payload) => applyIbPortal((payload.new as { value?: unknown })?.value),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
