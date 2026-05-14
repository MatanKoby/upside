import { env } from '../env.js';

export interface LlmAnalysisInput {
  symbol: string;
  companyName: string;
  position: { shares: number; avgCost: number; currentPrice: number };
  indicators: Record<string, unknown>;
  news: unknown[];
  earnings: unknown;
}

export interface LlmAnalysisOutput {
  signalType: 'sell' | 'no_signal';
  signalQuality: number;
  priceRangeLow: number | null;
  priceRangeHigh: number | null;
  optimalPrice: number | null;
  reasoning: string;
  indicatorBullets: { indicator: string; rationale: string }[];
}

export interface LlmProvider {
  analyze(input: LlmAnalysisInput): Promise<LlmAnalysisOutput>;
}

class GeminiProvider implements LlmProvider {
  async analyze(_input: LlmAnalysisInput): Promise<LlmAnalysisOutput> {
    throw new Error('GeminiProvider.analyze not implemented yet');
  }
}

class ClaudeProvider implements LlmProvider {
  async analyze(_input: LlmAnalysisInput): Promise<LlmAnalysisOutput> {
    throw new Error('ClaudeProvider.analyze not implemented yet');
  }
}

class OpenAiProvider implements LlmProvider {
  async analyze(_input: LlmAnalysisInput): Promise<LlmAnalysisOutput> {
    throw new Error('OpenAiProvider.analyze not implemented yet');
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
