// LLM provider abstraction for single-direction playbook analysis (Batch 14g).
//
// One Analyze call → one structured analysis carrying shared context
// (indicator readings + narrative) plus a single-direction `signal` (the
// playbook), or null = "looked, nothing actionable". Direction is chosen by
// the engine from holding status (held → sell, not-held → buy) and passed in;
// the prompt asks for that one direction so the model stays focused.
//
// Providers build the prompt and parse+validate the response against the
// direction-specific Zod schema; on malformed output they throw, and
// `signalEngine` orchestrates the single stricter retry + no-signal fallback.

import axios from 'axios';
import { z } from 'zod';
import { env } from '../env.js';
import { notifyApiFailure } from './notify.js';
import type { FeaturePack } from './technicals.js';

export type SignalDirection = 'sell' | 'buy';

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
  // Deterministic computed grounding — the LLM anchors legs to these levels.
  featurePack: FeaturePack;
  news: unknown[];
  earnings: unknown;
  insider: unknown;
  contextualTriggers: {
    inProfitTakingZone: { thresholdPct: number; currentPnlPct: number; viaGap: boolean } | null;
  };
}

// ---------------------------------------------------------------------------
// Output types (see signal-model.md → LLM output schema). The LLM produces the
// analysis *content*; signalEngine assigns analysis_id / timestamps / expiry,
// maps leg[0] into price_range_* and persists the full playbook.
// ---------------------------------------------------------------------------
export interface PlaybookLeg {
  action: SignalDirection; // sell / rebuy / resell …
  price: number; // anchored to a feature-pack level
  condition: 'at_or_above' | 'at_or_below' | 'about';
  confidence: number; // 0-100, decays down the chain
  reasoning: string;
}

export interface PlaybookSignal {
  direction: SignalDirection; // = holding-derived; the tracked signal_type
  signalQuality: number; // 0-100 headline conviction
  motivation: string; // direction-appropriate enum (validated below)
  horizon: 'intraday' | 'multiday';
  horizonWindow: string | null; // multiday e.g. "1-2 weeks"; null for intraday
  legs: PlaybookLeg[]; // ordered, >= 1; leg[0] = the immediate move
}

export interface LlmAnalysisOutput {
  indicatorAnalysis: Record<string, unknown>; // per-indicator one-line readings
  reasoning: string; // overall thesis / synthesis
  signal: PlaybookSignal | null; // null = no actionable case (no_signal)
}

const SELL_MOTIVATIONS = ['take_profit', 'derisk', 'avoid_downside'] as const;
const BUY_MOTIVATIONS = ['pullback_entry', 'breakout_continuation', 'value'] as const;

const legSchema = z.object({
  action: z.enum(['sell', 'buy']),
  price: z.number(),
  condition: z.enum(['at_or_above', 'at_or_below', 'about']),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().min(1),
});

// Direction-specific schema: the motivation enum is keyed off the *requested*
// direction so a SELL playbook can't carry a BUY motivation. `direction` is
// injected by the engine, not required from the model (an extra `direction`
// key the model emits is simply stripped).
function schemaFor(direction: SignalDirection) {
  const motivation = direction === 'sell' ? z.enum(SELL_MOTIVATIONS) : z.enum(BUY_MOTIVATIONS);
  const signal = z
    .object({
      signalQuality: z.number().min(0).max(100),
      motivation,
      horizon: z.enum(['intraday', 'multiday']),
      horizonWindow: z.string().nullish(),
      legs: z.array(legSchema).min(1),
    })
    .nullish();
  return z.object({
    indicatorAnalysis: z.record(z.string(), z.unknown()).default({}),
    reasoning: z.string().min(1),
    signal,
  });
}

export interface LlmProvider {
  analyze(input: LlmAnalysisInput, opts: { direction: SignalDirection; strict?: boolean }): Promise<LlmAnalysisOutput>;
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
// `direction` is injected into the validated signal (the engine owns it).
function parseAndValidate(text: unknown, direction: SignalDirection): LlmAnalysisOutput {
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
    const parsed = schemaFor(direction).parse(json);
    const signal: PlaybookSignal | null = parsed.signal
      ? {
          direction,
          signalQuality: parsed.signal.signalQuality,
          motivation: parsed.signal.motivation,
          horizon: parsed.signal.horizon,
          horizonWindow: parsed.signal.horizonWindow ?? null,
          legs: parsed.signal.legs,
        }
      : null;
    return { indicatorAnalysis: parsed.indicatorAnalysis, reasoning: parsed.reasoning, signal };
  } catch (e) {
    throw new LlmError('malformed', `schema validation failed: ${(e as Error).message} | ${raw}`);
  }
}

// ---------------------------------------------------------------------------
// Prompt — provider-agnostic, single-direction, level-anchored. `strict` is
// used for the single retry after a malformed first response.
// ---------------------------------------------------------------------------
function buildPrompt(input: LlmAnalysisInput, direction: SignalDirection, strict: boolean): string {
  const isSell = direction === 'sell';
  const held = input.position
    ? `HELD: ${input.position.shares} shares @ avg cost ${input.position.avgCost}` +
      (input.position.unrealizedPnlPct != null
        ? ` (unrealized P&L ${input.position.unrealizedPnlPct.toFixed(2)}%)`
        : '')
    : 'NOT HELD (watchlist candidate — no shares owned).';

  const stance = isSell
    ? 'The user HOLDS this position. Produce a SELL playbook — how to take profit / derisk this holding.'
    : 'The user does NOT hold this. Produce a BUY playbook — whether and how to enter.';

  const motivations = (isSell ? SELL_MOTIVATIONS : BUY_MOTIVATIONS).map((m) => `"${m}"`).join(' | ');

  const zone = input.contextualTriggers.inProfitTakingZone;
  // Neutral framing: state the fact, but make clear crossing the threshold is
  // context, not a directive to sell now — holding / waiting / no_signal are
  // all valid. (The earlier "take profit here, or hold?" wording biased the
  // model toward an immediate sell.)
  const zoneLine = zone
    ? `P&L has crossed +${zone.thresholdPct}% (currently ${zone.currentPnlPct.toFixed(2)}%)` +
      (zone.viaGap ? ', entered via an overnight gap (gaps often fade at open as others take profit).' : '.') +
      ' Treat this as context, NOT a directive: do not sell at the current price merely because of it. Holding, waiting for a better level, or returning no signal are all valid — only act if the levels and indicators justify it.'
    : 'None.';

  const strictPreamble = strict
    ? 'Your previous response was not valid JSON in the required shape. Respond with ONLY a single JSON ' +
      'object — no markdown, no code fences, no commentary. '
    : '';

  return `${strictPreamble}You are a trading-signal analyst for the Upside portfolio app. ${stance}

TICKER: ${input.symbol}${input.companyName ? ` (${input.companyName})` : ''}
${held}
Current price: ${input.currentPrice ?? 'unknown'}

COMPUTED FEATURE PACK — precise levels computed from IB bars. ANCHOR EVERY LEG'S PRICE TO ONE OF THESE LEVELS (pivots, swing highs/lows, SMA/EMA, Bollinger bands, VWAP, 20-day / 52-week highs/lows, round numbers). DO NOT invent or compute new prices:
${JSON.stringify(input.featurePack)}

RECENT NEWS (Finnhub, headlines + sentiment only): ${JSON.stringify((input.news ?? []).slice(0, 8))}
EARNINGS (Finnhub): ${JSON.stringify(input.earnings ?? null)}
INSIDER ACTIVITY (Finnhub): ${JSON.stringify(input.insider ?? null)}
CONTEXTUAL TRIGGERS:
- Profit-taking zone: ${zoneLine}

A "playbook" is an ordered list of legs. Leg 1 is the first action in the plan; later legs are the round-trip continuation (e.g. ${
    isSell ? 'sell into strength → rebuy on a pullback → resell higher' : 'buy the pullback → add on confirmation → trim into resistance'
  }). Each later leg should be LESS confident than the one before it.

Leg 1 does NOT have to execute at the current price — it is usually a RESTING ORDER at a level you expect price to reach. Choose the leg price from the feature pack first, then set "condition" by where that level sits relative to the current price (${input.currentPrice ?? 'current'}):
- level ABOVE current price → "at_or_above" (you are waiting for price to rise to it)
- level BELOW current price → "at_or_below" (you are waiting for price to fall to it)
- level AT/≈ current price → "about"
This is geometric, not directional: e.g. taking profit into resistance above price is "at_or_above"; a protective exit below price is "at_or_below".

Weigh the trend STRUCTURE before defaulting to mean-reversion: if the feature pack shows consolidation / a fresh range low / building relative volume (a coiling, pre-breakout setup), favour patience (a higher sell target, or no signal) over selling into a base.

Choose ONE horizon for the whole playbook: "intraday" (plays out within today's session) or "multiday" (then set horizonWindow, e.g. "1-2 weeks"). Leg timing is implied by order, not predicted per leg.

Return JSON with EXACTLY this shape:
{
  "indicatorAnalysis": { "<indicator>": "<one-line reading>" },
  "reasoning": "<overall thesis synthesizing the levels, indicators, news and context>",
  "signal": {
    "direction": "${direction}",
    "signalQuality": <0-100 headline conviction>,
    "motivation": ${motivations},
    "horizon": "intraday" | "multiday",
    "horizonWindow": "<e.g. 1-2 weeks; null for intraday>",
    "legs": [
      {
        "action": "sell" | "buy",
        "price": <number — MUST equal one of the feature-pack levels>,
        "condition": "at_or_above" | "at_or_below" | "about",
        "confidence": <0-100, decays down the chain>,
        "reasoning": "<one line citing the level/indicator that justifies this leg>"
      }
    ]
  } | null
}

Set "signal" to null only if there is genuinely no actionable ${direction.toUpperCase()} case (explain why in reasoning). Output ONLY the JSON object.`;
}

// Strips an accidental ```json … ``` fence if the model wraps its output.
function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  return t;
}

// ---------------------------------------------------------------------------
// Provider registry. `gemini` is native REST; groq/mistral/openrouter/openai
// share one OpenAI-compatible provider. Presets carry the base URL + a free-
// tier-friendly default model per host — add an entry to support a new host.
// Provider + model are injected per call (resolved from app_config, then env,
// in services/llmConfig.ts) so they can be switched on the fly.
// ---------------------------------------------------------------------------
export type LlmProviderName = 'gemini' | 'claude' | 'groq' | 'mistral' | 'openrouter' | 'openai';

interface OpenAiCompatPreset {
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
}

const OPENAI_COMPAT_PRESETS: Record<string, OpenAiCompatPreset> = {
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

const API_KEY_BY_PROVIDER: Record<string, string> = {
  gemini: env.geminiApiKey,
  groq: env.groqApiKey,
  mistral: env.mistralApiKey,
  openrouter: env.openrouterApiKey,
  openai: env.openaiApiKey,
};

// Providers that are actually implemented (claude is a stub) and so selectable.
const IMPLEMENTED_PROVIDERS: LlmProviderName[] = ['gemini', 'groq', 'mistral', 'openrouter', 'openai'];

// The provider's coded default model — shown in the UI as the "(default)" hint.
export function defaultModelFor(provider: string): string {
  if (provider === 'gemini') return 'gemini-2.0-flash';
  return OPENAI_COMPAT_PRESETS[provider]?.defaultModel ?? '';
}

// Implemented providers whose API key is present in env — the only ones the FE
// should offer and the config endpoint should accept (picking a keyless
// provider would just 503 on the next analyze).
export function availableProviders(): LlmProviderName[] {
  return IMPLEMENTED_PROVIDERS.filter((p) => !!API_KEY_BY_PROVIDER[p]);
}

class GeminiProvider implements LlmProvider {
  constructor(private readonly model: string) {}

  async analyze(input: LlmAnalysisInput, opts: { direction: SignalDirection; strict?: boolean }): Promise<LlmAnalysisOutput> {
    if (!env.geminiApiKey) throw new LlmError('config', 'GEMINI_API_KEY not set — cannot run Gemini analysis');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await axios.post(
      url,
      {
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input, opts.direction, opts.strict ?? false) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      },
      { params: { key: env.geminiApiKey }, timeout: 30_000, validateStatus: () => true },
    );
    notifyApiFailure('llm.gemini', res.status, { params: { model: this.model }, body: res.data });
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(classifyStatus(res.status), `Gemini ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
    }
    return parseAndValidate(res.data?.candidates?.[0]?.content?.parts?.[0]?.text, opts.direction);
  }
}

class ClaudeProvider implements LlmProvider {
  async analyze(): Promise<LlmAnalysisOutput> {
    throw new LlmError(
      'config',
      'ClaudeProvider not implemented — pick gemini | groq | mistral | openrouter | openai',
    );
  }
}

class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly provider: string,
    private readonly model: string,
  ) {}

  async analyze(input: LlmAnalysisInput, opts: { direction: SignalDirection; strict?: boolean }): Promise<LlmAnalysisOutput> {
    const preset = OPENAI_COMPAT_PRESETS[this.provider];
    if (!preset) throw new LlmError('config', `no OpenAI-compatible preset for provider=${this.provider}`);
    if (!preset.apiKey) {
      throw new LlmError('config', `${this.provider.toUpperCase()}_API_KEY not set — cannot run ${this.provider} analysis`);
    }
    const res = await axios.post(
      `${preset.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages: [{ role: 'user', content: buildPrompt(input, opts.direction, opts.strict ?? false) }],
        response_format: { type: 'json_object' },
        temperature: 0.4,
      },
      {
        headers: { Authorization: `Bearer ${preset.apiKey}` },
        timeout: 30_000,
        validateStatus: () => true,
      },
    );
    notifyApiFailure(`llm.${this.provider}`, res.status, { params: { model: this.model }, body: res.data });
    if (res.status < 200 || res.status >= 300) {
      throw new LlmError(
        classifyStatus(res.status),
        `${this.provider} ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`,
      );
    }
    return parseAndValidate(res.data?.choices?.[0]?.message?.content, opts.direction);
  }
}

// Build a provider for an explicit selection. Empty/null `model` → provider default.
export function llmFor(provider: string, model?: string | null): LlmProvider {
  const resolvedModel = (model && model.trim()) || defaultModelFor(provider);
  switch (provider) {
    case 'gemini':
      return new GeminiProvider(resolvedModel);
    case 'claude':
      return new ClaudeProvider();
    case 'groq':
    case 'mistral':
    case 'openrouter':
    case 'openai':
      return new OpenAiCompatibleProvider(provider, resolvedModel);
    default:
      throw new LlmError('config', `Unknown LLM provider: ${provider}`);
  }
}

// Env-configured default selection — the boot fallback when app_config has no
// row yet. Runtime selection goes through services/llmConfig.ts:activeLlm().
export function llm(): LlmProvider {
  return llmFor(env.llmProvider, env.llmModel || null);
}
