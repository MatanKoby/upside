import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.js';

let _client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

export async function pingSupabase(): Promise<boolean> {
  // Routes through the positions TableModule (the gatekeeper for that table);
  // imported lazily to avoid a load-time cycle (the module's base imports this).
  const { positionsTableModule } = await import('../db/positionsTableModule.js');
  return positionsTableModule.ping();
}
