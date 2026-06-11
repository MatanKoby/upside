// TableModule for `app_config` — the SOLE server-side gatekeeper for the
// runtime key/value config table (api/IB tunnel URLs, publishable key, etc.).
// Writers: tunnelWatcher (tunnel URLs), the appConfig.ts service (generic set).
// Readers: appConfig.ts service. The FE reads selected keys directly via
// Supabase + subscribes to Realtime; this module governs server-side I/O.
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

class AppConfigTableModule extends TableModule {
  constructor() {
    super('app_config');
  }

  /** Read one config value by key, or null when the key is absent. */
  async getValue(key: string): Promise<string | null> {
    const row = await this.run<{ value: string | null }>(
      'getValue',
      this.from().select('value').eq('key', key).maybeSingle(),
    );
    return row?.value ?? null;
  }

  /** Upsert one key/value pair (stamps updated_at). */
  async setValue(key: string, value: string): Promise<void> {
    await this.run(
      'setValue',
      this.from().upsert(
        { key, value, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      ),
    );
  }
}

export const appConfigTableModule = new AppConfigTableModule();
