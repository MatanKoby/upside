import { createClient, type RedisClientType } from 'redis';
import { env } from '../env.js';

let _client: RedisClientType | null = null;

export async function redis(): Promise<RedisClientType> {
  if (_client && _client.isOpen) return _client;
  _client = createClient({ url: env.redisUrl });
  _client.on('error', (err) => console.error('[redis]', err));
  await _client.connect();
  return _client;
}

export async function setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
  const c = await redis();
  await c.set(key, value, { EX: ttlSeconds });
}

export async function get(key: string): Promise<string | null> {
  const c = await redis();
  return c.get(key);
}

export async function del(key: string): Promise<void> {
  const c = await redis();
  await c.del(key);
}

export function ibSessionKey(userId: string): string {
  return `ib:session:${userId}`;
}

// Market-data snapshot cache (Batch 14e). Short TTL so opening TickerDetail
// repeatedly doesn't hammer IB/Finnhub, but stays fresh enough for day range +
// fundamentals. Keyed by symbol (not user) — the snapshot is the same for all.
export function marketSnapshotKey(symbol: string): string {
  return `marketdata:snapshot:${symbol.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// LLM daily cost counter (Batch 14a).
// One key per UTC day (`llm_calls:YYYY-MM-DD`) with a TTL that expires it at
// the next UTC midnight, so the count resets cleanly without a sweeper.
// ---------------------------------------------------------------------------
export function llmCallsKey(date = new Date().toISOString().slice(0, 10)): string {
  return `llm_calls:${date}`;
}

function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

// Increments today's counter and returns the new total. Sets the midnight-UTC
// TTL on the first increment of the day.
export async function incrLlmCallsToday(): Promise<number> {
  const c = await redis();
  const key = llmCallsKey();
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, secondsUntilUtcMidnight());
  return count;
}

export async function getLlmCallsToday(): Promise<number> {
  const c = await redis();
  const raw = await c.get(llmCallsKey());
  return raw ? Number(raw) : 0;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const c = await redis();
    const reply = await c.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
