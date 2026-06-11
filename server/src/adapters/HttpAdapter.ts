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
// runCount only when a slice needed it. The instrumentation that finnhub.ts and
// ibGateway.ts currently hand-roll (timing → external_api_metrics →
// notifyApiFailure → retry) lands here when those vendors migrate.

import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';

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
}
