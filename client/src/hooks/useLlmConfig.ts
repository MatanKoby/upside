import { useCallback, useEffect, useState } from 'react';
import { apiFetch, supabase } from '../services/supabase';

// Reads + writes the active LLM provider/model via the api (GET/POST
// /api/config/llm). The selection lives in Supabase app_config, so this also
// subscribes to Realtime on those keys — a change on another device refreshes
// here within ~1s. Keys themselves stay server-side; this only sees the choice.
export interface LlmConfig {
  provider: string;
  model: string | null;
  defaultModel: string;
  available: string[];
}

export function useLlmConfig() {
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/config/llm');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setConfig((await res.json()) as LlmConfig);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Another device changed the selection → reload so this view stays in sync.
  useEffect(() => {
    const channel = supabase
      .channel('app_config_llm')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_config', filter: 'key=eq.llm_provider' },
        () => void load(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_config', filter: 'key=eq.llm_model' },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const save = useCallback(async (provider: string, model: string | null): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/config/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      });
      const body = (await res.json()) as LlmConfig & { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConfig(body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { config, loading, saving, error, save, reload: load };
}
