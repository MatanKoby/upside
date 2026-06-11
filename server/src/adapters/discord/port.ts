// adapters/discord/port.ts — the contract the notifier policy layer depends on.
//
// Discord delivery is vendor-shaped: callers (services/notify.ts) speak in
// *logical channels* (errors, dip-buys, sell-zones, ...) plus an embed payload;
// the adapter resolves each channel to its configured webhook URL and posts.
// The policy layer never sees a webhook URL — that is the sole-path-of-access
// invariant (grep gate: env.discord*WebhookUrl only under adapters/discord/).

/** Logical Discord channels. Each maps to one configured webhook URL (or none). */
export type DiscordChannel =
  | 'errors'              // routine, recoverable error pings
  | 'errorsCritical'      // critical pings; falls back to `errors` when unset
  | 'zoneProfit'
  | 'dipBuys'
  | 'statsAlerts'
  | 'eventAlerts'
  | 'sellZones'
  | 'intradaySuggestions'
  | 'swingSuggestions';

export interface Notifier {
  /** True when `channel` resolves to a configured webhook URL (after fallback). */
  has(channel: DiscordChannel): boolean;
  /**
   * Deliver an embed payload to `channel`. No-ops when the channel isn't
   * configured. Never rejects — a webhook failure must not break the caller.
   */
  post(channel: DiscordChannel, payload: Record<string, unknown>): Promise<void>;
}
