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
    if (!env.geminiApiKey) throw new Error('GEMINI_API_KEY not set — cannot run Gemini analysis');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await axios.post(
      url,
      {
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input, opts?.strict ?? false) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      },
      { params: { key: env.geminiApiKey }, timeout: 30_000, validateStatus: () => true },
    );
    notifyApiFailure('llm.gemini', res.status);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Gemini ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    const text: unknown = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Gemini returned no text');
    const json = JSON.parse(stripFences(text)); // throws on non-JSON → caught by engine
    return normalize(llmAnalysisSchema.parse(json));
  }
}

class ClaudeProvider implements LlmProvider {
  async analyze(): Promise<LlmAnalysisOutput> {
    throw new Error('ClaudeProvider not implemented — set LLM_PROVIDER=gemini or implement using ANTHROPIC_API_KEY');
  }
}

class OpenAiProvider implements LlmProvider {
  async analyze(): Promise<LlmAnalysisOutput> {
    throw new Error('OpenAiProvider not implemented — set LLM_PROVIDER=gemini or implement using OPENAI_API_KEY');
  }
}

export function llm(): LlmProvider {
  switch (env.llmProvider) {
    case 'gemini':
      return new GeminiProvider();
    case 'claude':
      return new ClaudeProvider();
    case 'openai':
      return new OpenAiProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${env.llmProvider}`);
  }
}
