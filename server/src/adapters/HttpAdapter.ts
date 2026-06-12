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
//
// ARCH-8 (the ib migration) grew `instrumented()` for the things finnhub didn't
// exercise but ib needs, each opt-in so finnhub's calls are byte-identical:
//   - an internal-retry counter — `request` receives a `retry()` it can bump
//     from inside its own poll loop (ibSnapshot subscribe-then-poll); the final
//     count rides the metric row + the notify `detail`.
//   - `detail: "after N retries"` — added to the notify context when retries > 0.
//   - `skipNotify` — the debug passthrough records a metric but never pings
//     Discord (its probes are intentional experiments, not errors).
//   - `rawData` — return the response body even on a non-2xx, so the passthrough
//     can relay IB's actual error body (its whole purpose) instead of null.

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
  // on a single signal (unless `rawData`). The vendor client is
  // `validateStatus: () => true`, so a 4xx/5xx arrives here as a status, not a
  // throw. (A network error / timeout still throws straight through — the metric
  // row + notify only cover requests that returned a status; the IB connection
  // state is surfaced separately via /healthz.)
  protected async instrumented<T>(opts: {
    category: string;
    // Receives a `retry()` the request may bump from inside its own poll loop;
    // calls that don't retry (the common case) just ignore the argument.
    request: (retry: () => void) => Promise<AxiosResponse<T>>;
    conid?: number | null;
    retries?: number;
    skipNotify?: boolean;
    rawData?: boolean;
    notifyContext?: Record<string, unknown>;
  }): Promise<{ status: number; data: T | null }> {
    const start = performance.now();
    let retries = opts.retries ?? 0;
    const res = await opts.request(() => { retries++; });
    const durationMs = Math.round(performance.now() - start);
    const succeeded = res.status >= 200 && res.status < 300;
    this.recordMetric(opts.category, durationMs, res.status, succeeded, opts.conid ?? null, retries);
    if (!opts.skipNotify) {
      notifyApiFailure(`${this.vendor}_api.${opts.category}`, res.status, {
        ...opts.notifyContext,
        ...(retries > 0 ? { detail: `after ${retries} retries` } : {}),
        body: succeeded ? undefined : res.data,
      });
    }
    return { status: res.status, data: succeeded || opts.rawData ? res.data : null };
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
