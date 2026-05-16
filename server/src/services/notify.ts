// Discord webhook notifier. Set DISCORD_WEBHOOK_URL in .env on the VPS; the
// api posts terse "something went wrong" messages there so you don't have to
// SSH in to read docker logs every time something breaks.
//
// Per-key rate limiting (5 min cooldown) keeps a flapping subsystem from
// spamming the channel — first failure pings, subsequent identical-key
// failures within the window are dropped silently. The count since last
// notification is included in the next message so you know it kept happening.

import axios from 'axios';
import { env } from '../env.js';

const COOLDOWN_MS = 5 * 60_000;
const MAX_DESC_CHARS = 1800; // Discord embeds cap descriptions ~4k; stay well under

interface KeyState {
  lastSentAt: number;
  suppressedSince: number; // count of suppressed notifications since lastSentAt
}

const state = new Map<string, KeyState>();

function shortStack(err: unknown): string | null {
  if (!(err instanceof Error) || !err.stack) return null;
  // Keep just the message + top few frames, drop node_modules noise.
  const lines = err.stack.split('\n').filter((l, i) => i < 6 && !/\/node_modules\//.test(l));
  return lines.join('\n');
}

function describe(message: string, err: unknown): string {
  const errMsg = err instanceof Error ? err.message : err != null ? String(err) : '';
  const stack = shortStack(err);
  const parts = [message];
  if (errMsg && errMsg !== message) parts.push(errMsg);
  if (stack) parts.push('```\n' + stack + '\n```');
  const out = parts.join('\n');
  return out.length > MAX_DESC_CHARS ? out.slice(0, MAX_DESC_CHARS - 3) + '...' : out;
}

async function postWebhook(payload: Record<string, unknown>): Promise<void> {
  const url = env.discordWebhookUrl;
  if (!url) return; // silently no-op when not configured
  try {
    await axios.post(url, payload, { timeout: 5_000, validateStatus: () => true });
  } catch {
    // Don't let the notifier itself blow up the caller.
  }
}

/**
 * Notify Discord of an error. `key` identifies the error site (used for rate
 * limiting). Subsequent calls with the same key within COOLDOWN_MS are
 * suppressed; the next allowed notification includes the suppressed count.
 */
export async function notifyError(key: string, message: string, err?: unknown): Promise<void> {
  // Mirror to local logs first so we have a record even if Discord is down.
  if (err) console.error(`[${key}] ${message}`, err);
  else console.error(`[${key}] ${message}`);

  if (!env.discordWebhookUrl) return;

  const now = Date.now();
  const prev = state.get(key);
  if (prev && now - prev.lastSentAt < COOLDOWN_MS) {
    prev.suppressedSince += 1;
    return;
  }

  const suppressedNote = prev && prev.suppressedSince > 0
    ? `\n_(+ ${prev.suppressedSince} suppressed in the last 5 min)_`
    : '';

  state.set(key, { lastSentAt: now, suppressedSince: 0 });

  await postWebhook({
    username: 'upside',
    embeds: [{
      title: `🔴 ${key}`,
      description: describe(message, err) + suppressedNote,
      color: 0xE53935, // red
      timestamp: new Date(now).toISOString(),
    }],
  });
}

/**
 * Notify Discord of a less-severe event (e.g., reconnects, recovered state).
 * Same rate-limit semantics.
 */
export async function notifyInfo(key: string, message: string): Promise<void> {
  console.log(`[${key}] ${message}`);
  if (!env.discordWebhookUrl) return;

  const now = Date.now();
  const prev = state.get(key);
  if (prev && now - prev.lastSentAt < COOLDOWN_MS) {
    prev.suppressedSince += 1;
    return;
  }
  state.set(key, { lastSentAt: now, suppressedSince: 0 });
  await postWebhook({
    username: 'upside',
    embeds: [{
      title: `🟢 ${key}`,
      description: message.slice(0, MAX_DESC_CHARS),
      color: 0x43A047, // green
      timestamp: new Date(now).toISOString(),
    }],
  });
}
