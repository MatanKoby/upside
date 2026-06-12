// HttpAdapter base tests (Batch ARCH-8). The ARCH-7 finnhub tests cover the
// happy/non-2xx path end-to-end through a vendor; these isolate the base's
// `instrumented()` mechanics the ib slice grew: the retry counter, the
// `detail` note, `skipNotify`, and `rawData`. We drive `instrumented` directly
// with a fake `request` (the base only reads `res.status` / `res.data`), so no
// axios client or network is involved; the metric write + Discord notify are
// mocked to assert they fire with the right shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosResponse } from 'axios';

vi.mock('./supabase/externalApiMetricsTableModule.js', () => ({
  externalApiMetricsTableModule: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/notify.js', () => ({
  notifyApiFailure: vi.fn(),
}));

import { HttpAdapter } from './HttpAdapter.js';
import { externalApiMetricsTableModule } from './supabase/externalApiMetricsTableModule.js';
import { notifyApiFailure } from '../services/notify.js';

const mockRecord = externalApiMetricsTableModule.record as unknown as ReturnType<typeof vi.fn>;
const mockNotify = notifyApiFailure as unknown as ReturnType<typeof vi.fn>;

// Concrete subclass exposing the protected `instrumented` for the test. The
// base builds an axios client in its constructor, but these tests never call
// get()/post() — they hand `instrumented` a fake `request` directly.
class TestAdapter extends HttpAdapter {
  constructor() {
    super('test', 'http://example.test');
  }
  exec<T>(opts: {
    category: string;
    request: (retry: () => void) => Promise<AxiosResponse<T>>;
    conid?: number | null;
    retries?: number;
    skipNotify?: boolean;
    rawData?: boolean;
    notifyContext?: Record<string, unknown>;
  }) {
    return this.instrumented<T>(opts);
  }
}

const adapter = new TestAdapter();
const resp = <T>(status: number, data: T): AxiosResponse<T> => ({ status, data }) as AxiosResponse<T>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HttpAdapter.instrumented', () => {
  it('records a success metric (vendor-namespaced endpoint) and returns data on 2xx', async () => {
    const out = await adapter.exec({ category: 'thing', request: async () => resp(200, { ok: true }) });
    expect(out).toEqual({ status: 200, data: { ok: true } });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'test',
        endpoint: 'test:thing',
        status: 200,
        succeeded: true,
        retries: 0,
        conid: null,
      }),
    );
    expect(mockNotify).toHaveBeenCalledWith('test_api.thing', 200, expect.anything());
  });

  it('maps a non-2xx body to null and notifies with the body', async () => {
    const out = await adapter.exec({
      category: 'thing',
      conid: 42,
      request: async () => resp(500, { error: 'boom' }),
    });
    expect(out.data).toBeNull();
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'test:thing', status: 500, succeeded: false, conid: 42 }),
    );
    expect(mockNotify).toHaveBeenCalledWith(
      'test_api.thing',
      500,
      expect.objectContaining({ body: { error: 'boom' } }),
    );
  });

  it('counts internal retries onto the metric row and the notify detail', async () => {
    const out = await adapter.exec({
      category: 'snap',
      request: async (retry) => {
        retry();
        retry();
        return resp(503, { error: 'warming up' });
      },
    });
    expect(out.data).toBeNull();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ retries: 2, status: 503 }));
    expect(mockNotify).toHaveBeenCalledWith(
      'test_api.snap',
      503,
      expect.objectContaining({ detail: 'after 2 retries', body: { error: 'warming up' } }),
    );
  });

  it('omits the retry detail when there were no retries', async () => {
    await adapter.exec({ category: 'thing', request: async () => resp(500, 'x') });
    const ctx = mockNotify.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(ctx).not.toHaveProperty('detail');
  });

  it('skipNotify suppresses the Discord ping but still records the metric', async () => {
    await adapter.exec({ category: 'debug-passthrough:/foo', skipNotify: true, request: async () => resp(500, {}) });
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'test:debug-passthrough:/foo', succeeded: false }),
    );
  });

  it('rawData returns the response body even on a non-2xx (passthrough relay)', async () => {
    const out = await adapter.exec({
      category: 'debug-passthrough:/foo',
      skipNotify: true,
      rawData: true,
      request: async () => resp(404, { error: 'not found' }),
    });
    expect(out).toEqual({ status: 404, data: { error: 'not found' } });
  });
});
