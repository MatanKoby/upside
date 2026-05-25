// Active LLM selection (provider + model), resolved at analyze time from
// app_config first and the .env defaults as a boot fallback. Lets the provider
// be switched on the fly from the FE (no SSH, no redeploy) — the keys still
// live in .env; only the *choice* of provider/model is in Supabase.

import { env } from '../env.js';
import { getAppConfig, setAppConfig } from './appConfig.js';
import { availableProviders, llmFor, type LlmProvider, type LlmProviderName } from './llm.js';

export const LLM_PROVIDER_KEY = 'llm_provider';
export const LLM_MODEL_KEY = 'llm_model';

export interface LlmSelection {
  provider: string;
  model: string | null;
}

// app_config wins; env is the fallback when no row has been written yet.
export async function getLlmSelection(): Promise<LlmSelection> {
  const [provider, model] = await Promise.all([
    getAppConfig(LLM_PROVIDER_KEY),
    getAppConfig(LLM_MODEL_KEY),
  ]);
  return {
    provider: provider || env.llmProvider,
    model: (model && model.length ? model : env.llmModel) || null,
  };
}

export async function activeLlm(): Promise<LlmProvider> {
  const sel = await getLlmSelection();
  return llmFor(sel.provider, sel.model);
}

// Persist a new selection. Rejects a provider that isn't implemented + keyed.
// An empty/absent model clears the override so the provider default applies.
export async function setLlmSelection(provider: string, model?: string | null): Promise<LlmSelection> {
  const available = availableProviders();
  if (!available.includes(provider as LlmProviderName)) {
    throw new Error(`provider '${provider}' is not available (configured: ${available.join(', ') || 'none'})`);
  }
  const cleanModel = (model ?? '').trim();
  await setAppConfig(LLM_PROVIDER_KEY, provider);
  await setAppConfig(LLM_MODEL_KEY, cleanModel); // '' → provider default
  return { provider, model: cleanModel || null };
}
