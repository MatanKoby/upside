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

export async function pingRedis(): Promise<boolean> {
  try {
    const c = await redis();
    const reply = await c.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
