// Generic key/value access to the Supabase `app_config` table — the same
// runtime-config table that carries the Cloudflare tunnel URL (Batch 11). The
// FE reads selected keys directly (publishable key) and subscribes to Realtime;
// the api owns writes via the service role. Keep secrets OUT of here — values
// are readable by the browser.

import { supabase } from './supabase.js';
import { notifyError } from './notify.js';

export async function getAppConfig(key: string): Promise<string | null> {
  const { data, error } = await supabase()
    .from('app_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    void notifyError(`appConfig.get.${key}`, error.message);
    return null;
  }
  return data?.value ?? null;
}

export async function setAppConfig(key: string, value: string): Promise<void> {
  const { error } = await supabase()
    .from('app_config')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`app_config upsert '${key}' failed: ${error.message}`);
}
