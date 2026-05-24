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

async function postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  if (!url) return; // silently no-op when not configured
  try {
    await axios.post(url, payload, { timeout: 5_000, validateStatus: () => true });
  } catch {
    // Don't let the notifier itself blow up the caller.
  }
}

type Severity = 'error' | 'critical' | 'info';

const VISUAL: Record<Severity, { emoji: string; color: number }> = {
  error:    { emoji: '🔴', color: 0xE53935 },
  critical: { emoji: '🚨', color: 0xB71C1C },
  info:     { emoji: '🟢', color: 0x43A047 },
};

function webhookFor(sev: Severity): string {
  if (sev === 'critical') {
    // Critical routes to its own channel; fall back to the routine channel
    // if the critical webhook isn't configured (so we don't drop the message).
    return env.discordCriticalWebhookUrl || env.discordWebhookUrl;
  }
  return env.discordWebhookUrl;
}

async function notify(sev: Severity, key: string, message: string, err?: unknown): Promise<void> {
  // Mirror to local logs first so we have a record even if Discord is down.
  if (sev === 'info') {
    console.log(`[${key}] ${message}`);
  } else if (err) {
    console.error(`[${key}] ${message}`, err);
  } else {
    console.error(`[${key}] ${message}`);
  }

  const url = webhookFor(sev);
  if (!url) return;

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

  const v = VISUAL[sev];
  await postWebhook(url, {
    username: 'upside',
    embeds: [{
      title: `${v.emoji} ${key}`,
      description: describe(message, err) + suppressedNote,
      color: v.color,
      timestamp: new Date(now).toISOString(),
    }],
  });
}

/**
 * Routine error — recoverable, may flap. Goes to DISCORD_WEBHOOK_URL.
 */
export function notifyError(key: string, message: string, err?: unknown): Promise<void> {
  return notify('error', key, message, err);
}

/**
 * Critical error — process-level / structurally broken. Goes to
 * DISCORD_CRITICAL_WEBHOOK_URL (falls back to the routine channel if unset).
 */
export function notifyCritical(key: string, message: string, err?: unknown): Promise<void> {
  return notify('critical', key, message, err);
}

/**
 * Lower-severity event for the routine channel (e.g., reconnects, recovered
 * state). Same rate-limit semantics.
 */
export function notifyInfo(key: string, message: string): Promise<void> {
  return notify('info', key, message);
}

/**
 * Single policy for surfacing external-API failures (IB, Finnhub, ...) to
 * Discord, so the channel stays useful instead of becoming noise. Routes to the
 * routine channel, rate-limited per `key` (use the endpoint/category as the
 * key). Deliberately suppresses expected churn:
 *   - status < 400      → not a failure.
 *   - status 0          → thrown/network error; the caller's own catch owns it
 *                         (avoids double-notifying).
 *   - 401 / 403         → IB session transitions under the on-demand model;
 *                         a genuine login failure is reported critically by the
 *                         connect flow, not here.
 *   - 429               → rate-limited; the queue's backoff handles it.
 * Everything else (400, 404, 5xx, ...) is a real, actionable API error → ping.
 * Structural failures (process/loop crash, can't reach Supabase, IB connect
 * failure) use notifyCritical directly and are not funneled through here.
 */
export function notifyApiFailure(key: string, status: number, detail = ''): void {
  if (status < 400 || status === 401 || status === 403 || status === 429) return;
  void notify('error', key, `HTTP ${status}${detail ? ` ${detail}` : ''}`);
}
