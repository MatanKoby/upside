// useRiskFlagConfig — reads + writes the tunable risk-flag thresholds via the
// BE prefs route (Batch R2). The effective config (defaults merged with the
// user's override) comes back resolved, so Settings always shows live values.
// Persists through PUT /api/user/preferences for centralized validation
// (spec/screens/settings.md → Settings persistence).

import { useEffect, useState } from 'react';
import { apiFetch } from '../services/supabase';

export interface RiskFlagConfig {
  surgePct: number;
  surgeWindowSessions: number;
  volMult: number;
  rsiZ: number;
  near52wHighPct: number;
  microCapUsd: number;
  earningsDays: number;
}

interface PrefsResponse {
  riskFlagConfig: RiskFlagConfig;
  defaults: RiskFlagConfig;
  isCustom: boolean;
}

export interface UseRiskFlagConfigResult {
  config: RiskFlagConfig | null;
  defaults: RiskFlagConfig | null;
  isCustom: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: (next: RiskFlagConfig) => Promise<boolean>;
}

export function useRiskFlagConfig(): UseRiskFlagConfigResult {
  const [config, setConfig] = useState<RiskFlagConfig | null>(null);
  const [defaults, setDefaults] = useState<RiskFlagConfig | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/user/preferences')
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) {
          setError(`Couldn't load (${res.status})`);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as PrefsResponse;
        setConfig(body.riskFlagConfig);
        setDefaults(body.defaults);
        setIsCustom(body.isCustom);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save(next: RiskFlagConfig): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riskFlagConfig: next }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<PrefsResponse> & { error?: string };
      if (!res.ok) {
        setError(body.error ?? `Save failed (${res.status})`);
        setSaving(false);
        return false;
      }
      if (body.riskFlagConfig) setConfig(body.riskFlagConfig);
      setIsCustom(true);
      setSaving(false);
      return true;
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
      return false;
    }
  }

  return { config, defaults, isCustom, loading, saving, error, save };
}
