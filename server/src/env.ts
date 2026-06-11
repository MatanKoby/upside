import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3001')),

  allowedEmails: optional('UPSIDE_ALLOWED_EMAILS')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  supabaseUrl: required('SUPABASE_URL'),
  // Supabase's new key system. "publishable" replaces the old "anon" key
  // (safe to ship in the FE bundle). "secret" replaces "service_role"
  // (server-only, bypasses RLS). Functionally identical to legacy keys.
  supabasePublishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
  supabaseSecretKey: required('SUPABASE_SECRET_KEY'),

  googleOauthClientId: optional('GOOGLE_OAUTH_CLIENT_ID'),

  // gemini = native REST. groq / mistral / openrouter / openai all speak the
  // OpenAI chat-completions shape and share one provider (see llm.ts). Pick a
  // provider, set its key below. Base URL is coded per provider; add a preset
  // for a new host. LLM_MODEL optionally overrides the provider's default model.
  llmProvider: optional('LLM_PROVIDER', 'gemini') as
    | 'gemini'
    | 'claude'
    | 'openai'
    | 'groq'
    | 'mistral'
    | 'openrouter',
  llmModel: optional('LLM_MODEL'),
  geminiApiKey: optional('GEMINI_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),
  groqApiKey: optional('GROQ_API_KEY'),
  mistralApiKey: optional('MISTRAL_API_KEY'),
  openrouterApiKey: optional('OPENROUTER_API_KEY'),
  // Daily cap on unified analyses (each counts as one, regardless of how many
  // signals it emits). Per-day Redis counter resets at midnight UTC.
  maxLlmCallsPerDay: Number(optional('MAX_LLM_CALLS_PER_DAY', '50')),

  finnhubApiKey: optional('FINNHUB_API_KEY'),
  // Global token-bucket cap for Finnhub calls. Finnhub free tier is 60/min;
  // we leave a 10-call buffer. See server/src/adapters/finnhub/finnhubQueue.ts.
  finnhubRateLimitPerMin: Number(optional('FINNHUB_RATE_LIMIT_PER_MIN', '50')),

  // Polygon free-tier API key (Batch S0.5) — primary daily price+volume
  // source for the screener universe. Grouped-daily-bars endpoint returns
  // ALL US stocks in one call, well within the 5/min free cap.
  // See spec/data/sources.md → S0.5 universe-coverage decision.
  polygonApiKey: optional('POLYGON_API_KEY'),

  ibGatewayUrl: optional('IB_GATEWAY_URL', 'http://ib-gateway:5000'),
  redisUrl: optional('REDIS_URL', 'redis://redis:6379'),

  // Path to the cloudflared logfile, shared in from the cloudflared
  // container via a Docker named volume. The tunnel watcher tails it for
  // the current Quick Tunnel URL. See server/src/services/tunnelWatcher.ts.
  cloudflaredLogPath: optional('CLOUDFLARED_LOG_PATH', '/var/log/cloudflared/api.log'),

  // Optional Discord incoming-webhook URLs — when set, key error sites in
  // the api notify the channel (rate-limited per key). Two channels:
  //   DISCORD_ERRORS_WEBHOOK_URL          — routine errors (recoverable)
  //   DISCORD_ERRORS_CRITICAL_WEBHOOK_URL — process-level / structurally-broken
  //                                         (falls back to DISCORD_ERRORS_WEBHOOK_URL
  //                                          if unset)
  // See server/src/services/notify.ts.
  discordWebhookUrl: optional('DISCORD_ERRORS_WEBHOOK_URL'),
  discordCriticalWebhookUrl: optional('DISCORD_ERRORS_CRITICAL_WEBHOOK_URL'),
  // User-facing alert channels (Batch 14c) — one Discord webhook per alert type
  // so each can be muted/enabled independently in Discord. No-ops when unset.
  // Pattern: DISCORD_WEBHOOK_ZONE_<TYPE> (future: ZONE_DRAWDOWN, SIGNAL_SELL, …).
  discordZoneProfitWebhookUrl: optional('DISCORD_WEBHOOK_ZONE_PROFIT'),
  // DISCORD_WEBHOOK_DIP_BUYS — Batch A2. User-defined at_or_below marker hits
  // on watchlist tickers post here. (Other marker conditions / signal-range
  // pings get their own channels in follow-up batches.)
  discordDipBuysWebhookUrl: optional('DISCORD_WEBHOOK_DIP_BUYS'),
  // DISCORD_WEBHOOK_STATS_ALERTS — Batch B. Stats-derived alerts (price
  // entering a typical-intraday-low zone, etc.) go here, distinct from
  // dip-buys so the two mental categories (statistical-pattern vs. structural-
  // level / user-marker) can be muted independently.
  discordStatsAlertsWebhookUrl: optional('DISCORD_WEBHOOK_STATS_ALERTS'),
  // DISCORD_WEBHOOK_EVENT_ALERTS — Batch S2 / renamed X10. catalyst_reversal +
  // post_earnings_drift trait first-fire pings (once per ticker per day).
  // intraday_range_trader is silent — its band-touches carry the actionable
  // events. Renamed from DISCORD_WEBHOOK_CATALYST_ALERTS (it always carried
  // both event traits); the old var is still read as a fallback so a deploy
  // that hasn't updated its .env keeps working.
  discordEventAlertsWebhookUrl:
    optional('DISCORD_WEBHOOK_EVENT_ALERTS') || optional('DISCORD_WEBHOOK_CATALYST_ALERTS'),
  // DISCORD_WEBHOOK_SELL_ZONES — Batch S3. Predicted-high band touch on a
  // held position posts here (distinct from dip-buys so sell-side pings are
  // mutable independently). Low-touch on curated-not-held still routes to
  // DISCORD_WEBHOOK_DIP_BUYS — the existing dip-buys channel.
  discordSellZonesWebhookUrl: optional('DISCORD_WEBHOOK_SELL_ZONES'),
  // DISCORD_WEBHOOK_SUGGESTIONS_INTRADAY / _SWING — Batch X1. The two dip-bounce
  // scorers fire here (separate channels: intraday → react in seconds, swing →
  // think over hours; independent cooldowns + hit-rate horizons).
  discordIntradaySuggestionsWebhookUrl: optional('DISCORD_WEBHOOK_SUGGESTIONS_INTRADAY'),
  discordSwingSuggestionsWebhookUrl: optional('DISCORD_WEBHOOK_SUGGESTIONS_SWING'),
};
