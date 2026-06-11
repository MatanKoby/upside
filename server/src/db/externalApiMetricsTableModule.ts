// TableModule for `external_api_metrics` — the SOLE server-side gatekeeper for
// the outbound-API instrumentation log. Writers: the IB gateway wrappers
// (provider 'ib') and the Finnhub call wrapper (provider 'finnhub'), one row
// per outbound call. Retention: metricsRetention (30-day sweep on captured_at).
// No server-side reader (dashboards query it out-of-band).
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

export interface ApiMetric {
  provider: string; // 'ib' | 'finnhub'
  endpoint: string;
  conid: number | null;
  durationMs: number;
  retries: number;
  status: number;
  succeeded: boolean;
}

class ExternalApiMetricsTableModule extends TableModule {
  constructor() {
    super('external_api_metrics');
  }

  /** Append one outbound-call metric row. Callers fire-and-forget (the audit
   *  row must not fail the API call) — see the `.catch()` at each call-site. */
  async record(m: ApiMetric): Promise<void> {
    await this.run(
      'record',
      this.from().insert({
        provider: m.provider,
        endpoint: m.endpoint,
        conid: m.conid,
        duration_ms: m.durationMs,
        retries: m.retries,
        status: m.status,
        succeeded: m.succeeded,
      }),
    );
  }

  /** Retention — delete rows captured before `cutoff`; returns the deleted count. */
  async purgeOlderThan(cutoff: string): Promise<number> {
    return this.runCount(
      'purgeOlderThan',
      this.from().delete({ count: 'exact' }).lt('captured_at', cutoff),
    );
  }
}

export const externalApiMetricsTableModule = new ExternalApiMetricsTableModule();
