// Generic key/value access to the Supabase `app_config` table — the same
// runtime-config table that carries the Cloudflare tunnel URL (Batch 11). The
// FE reads selected keys directly (publishable key) and subscribes to Realtime;
// the api owns writes via the service role. Keep secrets OUT of here — values
// are readable by the browser.

import { appConfigTableModule } from '../adapters/supabase/appConfigTableModule.js';
import { notifyError } from './notify.js';

export async function getAppConfig(key: string): Promise<string | null> {
  try {
    return await appConfigTableModule.getValue(key);
  } catch (e: unknown) {
    void notifyError(`appConfig.get.${key}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function setAppConfig(key: string, value: string): Promise<void> {
  await appConfigTableModule.setValue(key, value);
}
