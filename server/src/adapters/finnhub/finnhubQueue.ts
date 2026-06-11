// Finnhub rate-limited request queue.
//
// All Finnhub HTTP calls in the codebase MUST route through `finnhubQueue.request`.
// The queue enforces a global token bucket (default 50 calls / minute,
// configurable via FINNHUB_RATE_LIMIT_PER_MIN) and per-(category, key)
// minimum intervals (default 0s; tuned in Batch 13.9 once real callers exist).
//
// Key behaviors:
//   - **No stale cache.** If a (category, key) is in its min-interval window
//     when called, the request WAITS for the next eligible slot — it never
//     returns a cached previous result. The caller always gets a fresh value.
//   - FIFO within a category (when multiple are ready). Categories share
//     the global token bucket, so across categories the order is whichever
//     becomes ready-and-funded first.
//   - One retry on 429 (defensive; the buffer below Finnhub's 60/min ceiling
//     should prevent these in normal operation).

import { env } from '../../env.js';

interface QueuedRequest<T> {
  category: string;
  key: string;
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function is429(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  // axios-style error
  const status = (e as { response?: { status?: number }; status?: number }).response?.status
    ?? (e as { status?: number }).status;
  return status === 429;
}

class FinnhubQueue {
  private maxTokens: number;
  private tokens: number;
  private refillIntervalMs: number;
  private lastRefillAt: number;

  private queue: QueuedRequest<unknown>[] = [];
  private lastFireAt: Map<string, number> = new Map();          // `${category}:${key}` → ts
  private categoryMinInterval: Map<string, number> = new Map(); // category → ms

  private draining = false;

  constructor(perMin: number) {
    this.maxTokens = perMin;
    this.tokens = perMin;
    this.refillIntervalMs = 60_000 / perMin;
    this.lastRefillAt = Date.now();
  }

  /** Set the minimum interval between successful calls for a (category, key) pair. */
  setCategoryMinInterval(category: string, intervalMs: number): void {
    this.categoryMinInterval.set(category, intervalMs);
  }

  /** Submit a Finnhub call. Returns a promise that resolves when the call eventually fires. */
  request<T>(category: string, key: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        category,
        key,
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
      void this.drain();
    });
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    const tokensToAdd = Math.floor(elapsed / this.refillIntervalMs);
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefillAt = this.lastRefillAt + tokensToAdd * this.refillIntervalMs;
    }
  }

  /** Time (ms) until at least one queued request becomes eligible to fire. */
  private soonestEligibleWait(): number {
    const now = Date.now();
    let minWait = Infinity;
    for (const r of this.queue) {
      const minInterval = this.categoryMinInterval.get(r.category) ?? 0;
      const last = this.lastFireAt.get(`${r.category}:${r.key}`) ?? 0;
      const wait = Math.max(0, minInterval - (now - last));
      if (wait < minWait) minWait = wait;
      if (minWait === 0) return 0;
    }
    return minWait === Infinity ? 0 : minWait;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        this.refillTokens();

        if (this.tokens < 1) {
          // Wait for the next refill tick.
          await sleep(Math.max(20, this.refillIntervalMs));
          continue;
        }

        // Find the earliest-enqueued request whose (category, key) is past
        // its min-interval. This preserves FIFO within a category — earlier
        // requests in the same category have earlier enqueuedAt timestamps,
        // and we scan in queue order.
        const now = Date.now();
        let pickIdx = -1;
        for (let i = 0; i < this.queue.length; i++) {
          const r = this.queue[i]!;
          const minInterval = this.categoryMinInterval.get(r.category) ?? 0;
          const last = this.lastFireAt.get(`${r.category}:${r.key}`) ?? 0;
          if (now - last >= minInterval) {
            pickIdx = i;
            break;
          }
        }

        if (pickIdx === -1) {
          // Everything blocked by per-key min-interval. Sleep until the
          // soonest one becomes eligible.
          await sleep(Math.max(20, this.soonestEligibleWait()));
          continue;
        }

        const req = this.queue.splice(pickIdx, 1)[0]!;
        this.tokens -= 1;
        this.lastFireAt.set(`${req.category}:${req.key}`, Date.now());
        // Fire asynchronously — don't block other ready requests from draining.
        void this.execute(req);
      }
    } finally {
      this.draining = false;
    }
  }

  private async execute(req: QueuedRequest<unknown>): Promise<void> {
    try {
      let result: unknown;
      try {
        result = await req.fn();
      } catch (e) {
        if (is429(e)) {
          // Defensive 429 retry — buffer below Finnhub's ceiling should make
          // this rare. Single retry with jitter; never retry more than once
          // to avoid amplifying upstream pressure.
          await sleep(500 + Math.floor(Math.random() * 500));
          result = await req.fn();
        } else {
          throw e;
        }
      }
      req.resolve(result);
    } catch (e) {
      req.reject(e);
    }
  }
}

export const finnhubQueue = new FinnhubQueue(env.finnhubRateLimitPerMin);
