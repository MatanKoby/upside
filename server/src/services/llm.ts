// LLM provider abstraction for unified SELL+BUY analysis (Batch 14a).
//
// One Analyze call → one structured analysis carrying shared context
// (indicator readings + narrative) plus a nullable `sellSignal` and a nullable
// `buySignal`. Both null is a valid "looked, nothing actionable" result.
//
// Providers build the prompt and parse+validate the response against the Zod
// schema below; on malformed output they throw, and `signalEngine` orchestrates
// the single stricter retry + no-signal fallback.

import axios from 'axios';
import { z } from 'zod';
import { env } from '../env.js';
import { notifyApiFailure } from './notify.js';

// ---------------------------------------------------------------------------
// Input — assembled by signalEngine from IB + Finnhub + position state.
// ---------------------------------------------------------------------------
export interface LlmAnalysisInput {
  symbol: string;
  companyName: string | null;
  conid: number;
  currentPrice: number | null;
  // null when the ticker is not held (watchlist candidate).
  position: { shares: number; avgCost: number; unrealizedPnlPct: number | null } | null;
  // Raw computed indicator values captured at analysis time.
  indicatorSnapshot: Record<string, unknown>;
  news: unknown[];
  earnings: unknown;
  insider: unknown;
  contextualTriggers: {
    inProfitTakingZone: { thresholdPct: number; currentPnlPct: number; viaGap: boolean } | null;
  };
}

// ---------------------------------------------------------------------------
// Output schema (Zod-enforced). The LLM produces the analysis *content*;
// signalEngine assigns analysis_id / timestamps / expiry and persists.
// ---------------------------------------------------------------------------
const sellSignalSchema = z
  .object({
    priceRangeLow: z.number(),
    priceRangeHigh: z.number(),
    optimalPrice: z.number(),
    signalQuality: z.number().min(0).max(100),
    motivation: z.enum(['take_profit', 'derisk', 'avoid_downside']),
    timeframe: z.string().min(1),
    rationale: z.string().min(1),
  })
  .nullish();

const buySignalSchema = z
  .object({
    priceRangeLow: z.number(),
    priceRangeHigh: z.number(),
    optimalPrice: z.number(),
    signalQuality: z.number().min(0).max(100),
    motivation: z.enum(['pullback_entry', 'breakout_continuation', 'value']),
    timeframe: z.string().min(1),
    rationale: z.string().min(1),
  })
  .nullish();

export const llmAnalysisSchema = z.object({
  indicatorAnalysis: z.record(z.string(), z.unknown()).default({}),
  reasoning: z.string().min(1),
  sellSignal: sellSignalSchema,
  buySignal: buySignalSchema,
});

export type LlmAnalysisOutput = z.infer<typeof llmAnalysisSchema>;
export type LlmSellSignal = NonNullable<LlmAnalysisOutput['sellSignal']>;
export type LlmBuySignal = NonNullable<LlmAnalysisOutput['buySignal']>;

export interface LlmProvider {
  analyze(input: LlmAnalysisInput, opts?: { strict?: boolean }): Promise<LlmAnalysisOutput>;
}

// ---------------------------------------------------------------------------
// Typed failures. `signalEngine` only re-prompts on `malformed`; a quota/outage
// won't be fixed by re-asking, so those skip the stricter retry and fail soft
// with an honest reason instead of being mislabeled "malformed".
// ---------------------------------------------------------------------------
export type LlmErrorKind = 'rate_limited' | 'unavailable' | 'malformed' | 'config';

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function classifyStatus(status: number): LlmErrorKind {
  if (status === 429) return 'rate_limited'; // quota / rate cap — transient
  if (status === 401 || status === 403) return 'config'; // bad/missing key
  return 'unavailable'; // 5xx, timeouts, status 0 (network), other non-2xx
}

// Shared body handling for every provider: strip fences, JSON.parse, Zod —
// any failure here is genuinely `malformed` (a 2xx with the wrong shape).
function parseAndValidate(text: unknown): LlmAnalysisOutput {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LlmError('malformed', 'provider returned no text');
  }
  // Include the raw response so the #errors channel shows *what* was malformed,
  // not just that validation failed — the only way to debug a bad LLM body.
  const raw = `raw: ${text.trim().slice(0, 400)}`;
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    throw new LlmError('malformed', `response was not valid JSON | ${raw}`);
  }
  try {
    return normalize(llmAnalysisSchema.parse(json));
  } catch (e) {
    throw new LlmError('malformed', `schema validation failed: ${(e as Error).message} | ${raw}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt — provider-agnostic. `strict` is used for the single retry after a
// malformed first response.
// ---------------------------------------------------------------------------
function buildPrompt(input: LlmAnalysisInput, strict: boolean): string {
  const held = input.position
    ? `HELD: ${input.position.shares} shares @ avg cost ${input.position.avgCost}` +
      (input.position.unrealizedPnlPct != null
        ? ` (unrealized P&L ${input.position.unrealizedPnlPct.toFixed(2)}%)`
        : '')
    : 'NOT HELD (watchlist candidate — no shares owned).';

  const zone = input.contextualTriggers.inProfitTakingZone;
  const zoneLine = zone
    ? `In profit-taking zone: P&L crossed +${zone.thresholdPct}% (currently ${zone.currentPnlPct.toFixed(2)}%)` +
      (zone.viaGap ? ', entered via an overnight gap (gaps often fade at open as others take profit).' : '.') +
      ' Address directly: take profit here, or hold for more?'
    : 'None.';

  const strictPreamble = strict
    ? 'Your previous response was not valid JSON in the required shape. Respond with ONLY a single JSON ' +
      'object — no markdown, no code fences, no commentary. '
    : '';

  return `${strictPreamble}You are a trading-signal analyst for the Upside portfolio app. Analyze the ticker below and return a single unified analysis that speaks to BOTH a potential SELL and a potential BUY.

TICKER: ${input.symbol}${input.companyName ? ` (${input.companyName})` : ''}
${held}
Current price: ${input.currentPrice ?? 'unknown'}

INDICATOR SNAPSHOT (computed from IB bars): ${JSON.stringify(input.indicatorSnapshot)}
RECENT NEWS (Finnhub): ${JSON.stringify((input.news ?? []).slice(0, 8))}
EARNINGS (Finnhub): ${JSON.stringify(input.earnings ?? null)}
INSIDER ACTIVITY (Finnhub): ${JSON.stringify(input.insider ?? null)}
CONTEXTUAL TRIGGERS:
- Profit-taking zone: ${zoneLine}

Return JSON with EXACTLY this shape:
{
  "indicatorAnalysis": { "<indicator>": "<one-line reading>", ... },
  "reasoning": "<overall narrative synthesizing the indicators, news and context>",
  "sellSignal": {
    "priceRangeLow": <number>, "priceRangeHigh": <number>,
    "optimalPrice": <number, = priceRangeHigh for a SELL>,
    "signalQuality": <0-100>,
    "motivation": "take_profit" | "derisk" | "avoid_downside",
    "timeframe": "<e.g. 3-7 days>",
    "rationale": "<why selling, one bullet>"
  } | null,
  "buySignal": {
    "priceRangeLow": <number>, "priceRangeHigh": <number>,
    "optimalPrice": <number, = priceRangeLow for a BUY>,
    "signalQuality": <0-100>,
    "motivation": "pullback_entry" | "breakout_continuation" | "value",
    "timeframe": "<e.g. 3-7 days>",
    "rationale": "<why buying, one bullet>"
  } | null
}

Set sellSignal to null if there is no actionable case to sell, and buySignal to null if there is no actionable case to buy. Both may be null. Output ONLY the JSON object.`;
}

// Zod accepts null|undefined for the signal blocks; normalize undefined → null.
function normalize(out: LlmAnalysisOutput): LlmAnalysisOutput {
  return { ...out, sellSignal: out.sellSignal ?? null, buySignal: out.buySignal ?? null };
}

// Strips an accidental ```json … ``` fence if the model wraps its output.
function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return t;
}

class GeminiProvider implements LlmProvider {
  private model = 'gemini-2.0-flash';

  async analyze(input: LlmAnalysisInput, opts?: { strict?: boolean }): Promise<LlmAnalysisOutput> {
    if (!env.geminiApiKey) throw new LlmError('config', 'GEMINI_API_KEY not set — cannot run Gemini analysis');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await axios.post(
      url,
      {
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input, opts?.strict ?? false) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      },
      { params: { key: env.geminiApiKey }, timeout: 30_000, validateStatus: () => true },
    );
    notifyApiFailure('llm.gemini', res.status, { params: { model: this.model }, body: res.data });
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(classifyStatus(res.status), `Gemini ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    return parseAndValidate(res.data?.candidates?.[0]?.content?.parts?.[0]?.text);
  }
}

class ClaudeProvider implements LlmProvider {
  async analyze(): Promise<LlmAnalysisOutput> {
    throw new LlmError(
      'config',
      'ClaudeProvider not implemented — set LLM_PROVIDER=gemini|groq|mistral|openrouter or implement using ANTHROPIC_API_KEY',
    );
  }
}

// ---------------------------------------------------------------------------
// One provider for every OpenAI chat-completions endpoint. Presets carry the
// base URL + a sensible default model and free-tier-friendly choice per host;
// LLM_BASE_URL / LLM_MODEL override either. Swap hosts by changing env only.
// ---------------------------------------------------------------------------
interface OpenAiCompatPreset {
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
}

function openAiCompatPreset(): { provider: string } & OpenAiCompatPreset {
  const presets: Record<string, OpenAiCompatPreset> = {
    groq: {
      baseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'llama-3.3-70b-versatile',
      apiKey: env.groqApiKey,
    },
    mistral: {
      baseUrl: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-small-latest',
      apiKey: env.mistralApiKey,
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
      apiKey: env.openrouterApiKey,
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      apiKey: env.openaiApiKey,
    },
  };
  const p = presets[env.llmProvider];
  if (!p) throw new LlmError('config', `no OpenAI-compatible preset for LLM_PROVIDER=${env.llmProvider}`);
  return {
    provider: env.llmProvider,
    baseUrl: env.llmBaseUrl || p.baseUrl,
    defaultModel: env.llmModel || p.defaultModel,
    apiKey: p.apiKey,
  };
}

class OpenAiCompatibleProvider implements LlmProvider {
  async analyze(input: LlmAnalysisInput, opts?: { strict?: boolean }): Promise<LlmAnalysisOutput> {
    const { provider, baseUrl, defaultModel, apiKey } = openAiCompatPreset();
    if (!apiKey) {
      throw new LlmError('config', `${provider.toUpperCase()}_API_KEY not set — cannot run ${provider} analysis`);
    }
    const res = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model: defaultModel,
        messages: [{ role: 'user', content: buildPrompt(input, opts?.strict ?? false) }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
    notifyApiFailure(`llm.${provider}`, res.status, { params: { model: defaultModel }, body: res.data });
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(
        classifyStatus(res.status),
        `${provider} ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
      );
    }
    return parseAndValidate(res.data?.choices?.[0]?.message?.content);
  }
}

export function llm(): LlmProvider {
  switch (env.llmProvider) {
    case 'gemini':
      return new GeminiProvider();
    case 'claude':
      return new ClaudeProvider();
    case 'groq':
    case 'mistral':
    case 'openrouter':
    case 'openai':
      return new OpenAiCompatibleProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${env.llmProvider}`);
  }
}
