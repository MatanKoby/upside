# LLM Provider Abstraction

- Provider-agnostic interface: `analyze(context, { direction }) → single-direction playbook`, in `server/src/services/llm.ts`.
- **Current: Groq `llama-3.3-70b-versatile`** — free tier, proven. Served by `OpenAiCompatibleProvider` (one provider for every OpenAI chat-completions host; presets = base URL + default model). **Mistral** configured, not yet exercised; OpenRouter / OpenAI available the same way. **Gemini** (native REST) implemented but parked (free tier 429'd). `ClaudeProvider` is a stub.
- **Model strength matters for tactical reads.** Playbook quality depends heavily on the model — a free Llama is weaker than a stronger model. Revisiting the provider is a follow-up once the playbook format is proven.
- **Selection is runtime** via `app_config` (`llm_provider`/`llm_model`), switched through `GET`/`POST /api/config/llm` + the Settings picker — no restart. **API keys stay in `.env`**, never in `app_config`; only the *choice* is in Supabase.
- **Failure handling** (`LlmError{ kind }`): non-2xx classified (`429`→`rate_limited`, `401/403`→`config`, else `unavailable`); only a 2xx body failing JSON/Zod is `malformed`. Re-prompt once (stricter) only on `malformed`; everything else fails soft to `no_signal` with an honest reason. Malformed bodies carry a snippet to `#errors`.
