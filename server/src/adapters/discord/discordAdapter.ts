// adapters/discord/discordAdapter.ts — SOLE importer of the env.discord*WebhookUrl
// set. Resolves a logical channel to its webhook URL and POSTs the embed.
//
// Discord is a multi-URL delivery sink (one full incoming-webhook URL per
// channel), not a single-base REST API, so this does NOT extend HttpAdapter —
// it posts to absolute URLs. All notifier *policy* (cooldown, embed formatting,
// per-alert formatters) stays in services/notify.ts; this owns only delivery.

import axios from 'axios';
import { env } from '../../env.js';
import type { DiscordChannel, Notifier } from './port.js';

const TIMEOUT_MS = 5_000;

/** Injectable delivery seam — a test passes a fake to capture (url, payload). */
type Deliver = (url: string, payload: Record<string, unknown>) => Promise<void>;

// Production delivery: POST the embed and swallow everything. Discord being
// down (or returning 4xx/5xx — hence permissive validateStatus) must never
// surface to the caller, so this never rejects.
async function axiosDeliver(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await axios.post(url, payload, { timeout: TIMEOUT_MS, validateStatus: () => true });
  } catch {
    // Don't let the notifier itself blow up the caller.
  }
}

export class DiscordAdapter implements Notifier {
  constructor(private readonly deliver: Deliver = axiosDeliver) {}

  private urlFor(channel: DiscordChannel): string | undefined {
    switch (channel) {
      case 'errors':              return env.discordWebhookUrl;
      // Critical falls back to the routine channel so a critical message is
      // never dropped when its dedicated webhook isn't configured.
      case 'errorsCritical':      return env.discordCriticalWebhookUrl || env.discordWebhookUrl;
      case 'zoneProfit':          return env.discordZoneProfitWebhookUrl;
      case 'dipBuys':             return env.discordDipBuysWebhookUrl;
      case 'statsAlerts':         return env.discordStatsAlertsWebhookUrl;
      case 'eventAlerts':         return env.discordEventAlertsWebhookUrl;
      case 'sellZones':           return env.discordSellZonesWebhookUrl;
      case 'intradaySuggestions': return env.discordIntradaySuggestionsWebhookUrl;
      case 'swingSuggestions':    return env.discordSwingSuggestionsWebhookUrl;
    }
  }

  has(channel: DiscordChannel): boolean {
    return !!this.urlFor(channel);
  }

  async post(channel: DiscordChannel, payload: Record<string, unknown>): Promise<void> {
    const url = this.urlFor(channel);
    if (!url) return; // silently no-op when not configured
    await this.deliver(url, payload);
  }
}

export const discord: Notifier = new DiscordAdapter();
