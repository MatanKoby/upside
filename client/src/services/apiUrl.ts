import { supabase } from './supabase';

// Discovers the api's public URL from Supabase app_config and keeps the
// in-memory + localStorage caches fresh via a Realtime subscription. The api
// URL is set by the cloudflared tunnel watcher on the BE (see
// server/src/services/tunnelWatcher.ts) and changes whenever the Quick Tunnel
// URL rotates. Architecture: UPSIDE_MVP_SPEC.md → "Public URL Discovery".

const STORAGE_KEY = 'upside_api_url';

let inMemoryUrl: string | null = null;

function readLocalStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalStorage(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // localStorage unavailable (private mode, etc.) — in-memory cache still works.
  }
}

function clearLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function getApiUrl(): Promise<string> {
  if (inMemoryUrl) return inMemoryUrl;

  const fromStorage = readLocalStorage();
  if (fromStorage) {
    inMemoryUrl = fromStorage;
    return fromStorage;
  }

  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'api_url')
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load api_url from Supabase: ${error.message}`);
  }
  if (!data?.value) {
    throw new Error(
      'app_config.api_url not yet populated. Ensure the BE tunnel watcher has run at least once.',
    );
  }

  inMemoryUrl = data.value;
  writeLocalStorage(data.value);
  return data.value;
}

export function clearCachedApiUrl(): void {
  inMemoryUrl = null;
  clearLocalStorage();
}

// Subscribes to Supabase Realtime on app_config and refreshes the cache when
// the api_url row changes. Call once at app mount; the returned function
// tears down the subscription on unmount.
export function subscribeToApiUrl(): () => void {
  const apply = (next: unknown): void => {
    if (typeof next !== 'string') return;
    if (next === inMemoryUrl) return;
    console.log(`[apiUrl] received update: ${inMemoryUrl ?? '(none)'} -> ${next}`);
    inMemoryUrl = next;
    writeLocalStorage(next);
  };

  const channel = supabase
    .channel('app_config_api_url')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'app_config', filter: 'key=eq.api_url' },
      (payload) => apply((payload.new as { value?: unknown })?.value),
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'app_config', filter: 'key=eq.api_url' },
      (payload) => apply((payload.new as { value?: unknown })?.value),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
}
