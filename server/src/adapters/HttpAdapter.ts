// HttpAdapter — shared base for vendor HTTP adapters (Phase 2, ports & adapters).
//
// Every external vendor sits behind ONE adapter — the sole path of access to
// that vendor (docs/arch/target-architecture.md → Phase 2). Callers depend on a
// Port interface, never the vendor SDK. This base owns the cross-cutting HTTP
// mechanics: one axios client bound to the vendor's base URL + a permissive
// validateStatus (the adapter inspects the status itself and maps/throws). It is
// the HTTP analog of db/TableModule.ts.
//
// Kept minimal on purpose — it grows per slice, the way TableModule gained
// runCount only when a slice needed it. ARCH-7 (the finnhub migration) landed
// the `instrumented()` path below: the timing → external_api_metrics →
// notifyApiFailure wrapper that finnhub.ts hand-rolled, now shared. Vendors that
// want a raw, un-audited call (polygon/yahoo, whose callers own their own notify
// policy) keep using `get()`/`post()` directly and never touch instrumented().

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { externalApiMetricsTableModule } from './supabase/externalApiMetricsTableModule.js';
import { notifyApiFailure } from '../services/notify.js';

export abstract class HttpAdapter {
  protected readonly http: AxiosInstance;

  constructor(
    protected readonly vendor: string,
    baseUrl: string,
    timeoutMs = 30_000,
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: timeoutMs,
      // Adapters inspect the status and map/throw themselves — never throw here.
      validateStatus: () => true,
    });
  }

  protected get<T>(path: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.get<T>(path, config);
  }

  protected post<T>(path: string, body?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.post<T>(path, body, config);
  }

  // Audited call: time the request, append one `external_api_metrics` row
  // (provider = vendor, endpoint = `<vendor>:<category>`), and run the standard
  // Discord failure policy (`<vendor>_api.<category>`, suppressed on success).
  // Returns `data` only on a 2xx — non-2xx maps to `null` so the caller branches
  // on a single signal. The vendor client is `validateStatus: () => true`, so a
  // 4xx/5xx arrives here as a status, not a throw.
  protected async instrumented<T>(opts: {
    category: string;
    request: () => Promise<AxiosResponse<T>>;
    conid?: number | null;
    retries?: number;
    notifyContext?: Record<string, unknown>;
  }): Promise<{ status: number; data: T | null }> {
    const start = performance.now();
    const res = await opts.request();
    const durationMs = Math.round(performance.now() - start);
    const succeeded = res.status >= 200 && res.status < 300;
    this.recordMetric(opts.category, durationMs, res.status, succeeded, opts.conid ?? null, opts.retries ?? 0);
    notifyApiFailure(`${this.vendor}_api.${opts.category}`, res.status, {
      ...opts.notifyContext,
      body: succeeded ? undefined : res.data,
    });
    return { status: res.status, data: succeeded ? res.data : null };
  }

  // Fire-and-forget audit row — the metric write must never fail the API call.
  private recordMetric(
    category: string,
    durationMs: number,
    status: number,
    succeeded: boolean,
    conid: number | null,
    retries: number,
  ): void {
    void externalApiMetricsTableModule
      .record({
        provider: this.vendor,
        endpoint: `${this.vendor}:${category}`,
        conid,
        durationMs,
        retries,
        status,
        succeeded,
      })
      .catch((err) => console.error('[external_api_metrics insert]', err?.message ?? err));
  }
}
