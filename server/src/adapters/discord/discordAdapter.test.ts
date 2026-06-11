import { describe, it, expect, vi } from 'vitest';
import { DiscordAdapter } from './discordAdapter.js';

// Control which channels are "configured" by mocking the env module. Critical
// is intentionally left unset to exercise the fallback to the routine channel.
vi.mock('../../env.js', () => ({
  env: {
    discordWebhookUrl: 'https://hook/errors',
    discordCriticalWebhookUrl: '',
    discordZoneProfitWebhookUrl: '',
    discordDipBuysWebhookUrl: 'https://hook/dip',
    discordStatsAlertsWebhookUrl: '',
    discordEventAlertsWebhookUrl: '',
    discordSellZonesWebhookUrl: '',
    discordIntradaySuggestionsWebhookUrl: '',
    discordSwingSuggestionsWebhookUrl: '',
  },
}));

describe('DiscordAdapter', () => {
  it('delivers the embed to the channel webhook URL', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    await new DiscordAdapter(deliver).post('dipBuys', { content: 'hi' });
    expect(deliver).toHaveBeenCalledWith('https://hook/dip', { content: 'hi' });
  });

  it('falls back to the routine errors URL for errorsCritical when unset', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    await new DiscordAdapter(deliver).post('errorsCritical', { content: 'boom' });
    expect(deliver).toHaveBeenCalledWith('https://hook/errors', { content: 'boom' });
  });

  it('no-ops (never delivers) when the channel is unconfigured', async () => {
    const deliver = vi.fn();
    await new DiscordAdapter(deliver).post('zoneProfit', { content: 'x' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('has() reflects configured-ness, including the critical fallback', () => {
    const d = new DiscordAdapter(vi.fn());
    expect(d.has('errors')).toBe(true);
    expect(d.has('dipBuys')).toBe(true);
    expect(d.has('errorsCritical')).toBe(true); // via fallback to routine
    expect(d.has('zoneProfit')).toBe(false);
  });
});
