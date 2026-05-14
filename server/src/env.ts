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
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),

  googleOauthClientId: optional('GOOGLE_OAUTH_CLIENT_ID'),

  llmProvider: (optional('LLM_PROVIDER', 'gemini') as 'gemini' | 'claude' | 'openai'),
  geminiApiKey: optional('GEMINI_API_KEY'),
  anthropicApiKey: optional('ANTHROPIC_API_KEY'),
  openaiApiKey: optional('OPENAI_API_KEY'),

  finnhubApiKey: optional('FINNHUB_API_KEY'),

  ibGatewayUrl: optional('IB_GATEWAY_URL', 'http://ib-gateway:5000'),
  redisUrl: optional('REDIS_URL', 'redis://redis:6379'),
};
