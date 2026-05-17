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

  llmProvider: (optional('LLM_PROVIDER', 'gemini') as 'gemini' | 'claude' | 'openai'),
  geminiApiKey: optional('GEMINI_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),

  finnhubApiKey: optional('FINNHUB_API_KEY'),
  // Global token-bucket cap for Finnhub calls. Finnhub free tier is 60/min;
  // we leave a 10-call buffer. See server/src/services/finnhubQueue.ts.
  finnhubRateLimitPerMin: Number(optional('FINNHUB_RATE_LIMIT_PER_MIN', '50')),

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
};
