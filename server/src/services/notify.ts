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

type EmbedField = { name: string; value: string; inline?: boolean };

async function notify(
  sev: Severity,
  key: string,
  message: string,
  opts: { err?: unknown; fields?: EmbedField[] } = {},
): Promise<void> {
  const { err, fields } = opts;
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
  const embed: Record<string, unknown> = {
    title: `${v.emoji} ${key}`,
    description: describe(message, err) + suppressedNote,
    color: v.color,
    timestamp: new Date(now).toISOString(),
  };
  // Discord caps field values at 1024 chars and 25 fields per embed.
  if (fields && fields.length) {
    embed.fields = fields.slice(0, 25).map((f) => ({
      name: f.name.slice(0, 256),
      value: f.value.slice(0, 1024),
      inline: f.inline ?? false,
    }));
  }
  await postWebhook(url, { username: 'upside', embeds: [embed] });
}

/**
 * Routine error — recoverable, may flap. Goes to DISCORD_WEBHOOK_URL.
 */
export function notifyError(key: string, message: string, err?: unknown): Promise<void> {
  return notify('error', key, message, { err });
}

/**
 * Critical error — process-level / structurally broken. Goes to
 * DISCORD_CRITICAL_WEBHOOK_URL (falls back to the routine channel if unset).
 */
export function notifyCritical(key: string, message: string, err?: unknown): Promise<void> {
  return notify('critical', key, message, { err });
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
function fmtParams(params: Record<string, unknown> | string | undefined): string | null {
  if (params == null) return null;
  if (typeof params === 'string') return params || null;
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return null;
  return entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

function fmtBody(body: unknown): string | null {
  if (body == null) return null;
  let s: string;
  if (typeof body === 'string') s = body;
  else {
    try { s = JSON.stringify(body); } catch { s = String(body); }
  }
  s = s.trim();
  if (!s || s === '{}' || s === 'null') return null;
  return s.length > 900 ? s.slice(0, 900) + '…' : s;
}

export interface ApiFailureContext {
  detail?: string;                              // short note, e.g. "after 4 retries"
  params?: Record<string, unknown> | string;    // call params (conid, symbol, period, ...)
  body?: unknown;                               // the response body that came back
}

/**
 * Profit-taking-zone entry alert (Batch 14c). Posts to the dedicated
 * DISCORD_WEBHOOK_ZONE_PROFIT channel. Unlike the error path, this has NO
 * in-memory cooldown — the 4h re-entry cooldown is owned by the caller (anchored
 * on `positions.last_zone_notification_at` so it survives restarts). No-ops when
 * the channel isn't configured.
 *
 * One function per alert type (each its own channel) so notifications can be
 * tuned independently — a future drawdown zone gets a parallel
 * notifyDrawdownZoneEntry + DISCORD_WEBHOOK_ZONE_DRAWDOWN.
 */
export function notifyProfitZoneEntry(args: {
  symbol: string;
  pnlPct: number;
  thresholdPct: number;
  viaGap: boolean;
}): Promise<void> {
  const { symbol, pnlPct, thresholdPct, viaGap } = args;
  const gapSuffix = viaGap ? ' · entered outside regular hours (gap — often fades at open)' : '';
  const line = `🔔 ${symbol} entered profit-taking zone — P&L +${pnlPct.toFixed(2)}% (threshold +${thresholdPct}%)${gapSuffix}`;
  console.log(`[zone] ${line}`);
  const url = env.discordZoneProfitWebhookUrl;
  if (!url) return Promise.resolve();
  return postWebhook(url, {
    username: 'upside',
    embeds: [{
      title: `🔔 ${symbol} · profit-taking zone`,
      description: line,
      color: 0x43A047,
      timestamp: new Date().toISOString(),
    }],
  });
}

/**
 * Dip-buy marker hit (Batch A2). User-defined `at_or_below` price marker on a
 * watchlist ticker just crossed. Posts to DISCORD_WEBHOOK_DIP_BUYS. Cooldown
 * is owned by the caller (anchored on `watchlist_markers.last_fired_at` so it
 * survives restarts), matching the zone-profit pattern. No-ops when the
 * channel isn't configured.
 *
 * Other marker conditions (`at_or_above` for targets, `about` for level
 * proximity) will get their own notifiers + channels in follow-up batches.
 */
/**
 * Entry-zone hit (Batch A+). Price has entered a computed entry zone for
 * one of the three horizons. Posts to DISCORD_WEBHOOK_DIP_BUYS (same channel
 * as user-defined markers for the first cut). 24h cooldown anchored on
 * `entry_zones.last_fired_at` per (conid, horizon).
 */
export function notifyEntryZoneHit(args: {
  symbol: string;
  horizon: 'intraday' | 'overnight' | 'multiday';
  zonePrice: number;
  currentPrice: number;
  reasoning: string;
  confidence: number;
}): Promise<void> {
  const { symbol, horizon, zonePrice, currentPrice, reasoning, confidence } = args;
  const line = `🟢 ${symbol} hit ${horizon} entry zone — $${zonePrice} (${reasoning}, ${confidence}%) · current $${currentPrice}`;
  console.log(`[entry-zones] ${line}`);
  const url = env.discordDipBuysWebhookUrl;
  if (!url) return Promise.resolve();
  return postWebhook(url, {
    username: 'upside',
    embeds: [{
      title: `🟢 ${symbol} · ${horizon} entry zone hit`,
      description: line,
      color: 0x639922,
      timestamp: new Date().toISOString(),
    }],
  });
}

export function notifyDipBuyMarkerHit(args: {
  symbol: string;
  markerPrice: number;
  currentPrice: number;
  label: string | null;
}): Promise<void> {
  const { symbol, markerPrice, currentPrice, label } = args;
  const tag = label ? ` ("${label}")` : '';
  const line = `🟢 ${symbol} hit dip-buy at $${markerPrice}${tag} — current $${currentPrice}`;
  console.log(`[markers] ${line}`);
  const url = env.discordDipBuysWebhookUrl;
  if (!url) return Promise.resolve();
  return postWebhook(url, {
    username: 'upside',
    embeds: [{
      title: `🟢 ${symbol} · dip-buy hit`,
      description: line,
      color: 0x639922,
      timestamp: new Date().toISOString(),
    }],
  });
}

export function notifyApiFailure(key: string, status: number, ctx: ApiFailureContext = {}): void {
  if (status < 400 || status === 401 || status === 403 || status === 429) return;
  const fields: EmbedField[] = [{ name: 'Status', value: String(status), inline: true }];
  if (ctx.detail) fields.push({ name: 'Note', value: ctx.detail, inline: true });
  const params = fmtParams(ctx.params);
  if (params) fields.push({ name: 'Params', value: params, inline: false });
  const body = fmtBody(ctx.body);
  if (body) fields.push({ name: 'Response', value: '```\n' + body + '\n```', inline: false });
  void notify('error', key, `HTTP ${status}`, { fields });
}
