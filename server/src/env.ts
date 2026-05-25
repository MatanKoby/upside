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
  // provider, set its key below; optionally override the model with LLM_MODEL
  // or the endpoint with LLM_BASE_URL (defaults baked in per provider).
  llmProvider: optional('LLM_PROVIDER', 'gemini') as
    | 'gemini'
    | 'claude'
    | 'openai'
    | 'groq'
    | 'mistral'
    | 'openrouter',
  llmBaseUrl: optional('LLM_BASE_URL'),
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
