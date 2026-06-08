// useUserPreferences — reads + writes the general app-level prefs that aren't
// part of the LLM-analysis (Analyze) flow. Today that's just the profit-taking
// zone threshold; the signal-generation knobs (threshold / min market value /
// suppressed symbols) live with the LLM-analysis track in spec/roadmap.md.
// Risk-flag thresholds have their own hook (useRiskFlagConfig) against the same
// endpoint; both write through PUT /api/user/preferences for centralized
// validation (spec/screens/settings.md → Settings persistence).

import { useEffect, useState } from 'react';
import { apiFetch } from '../services/supabase';

export interface UserPreferences {
  profitZoneThresholdPct: number;
}

interface PrefsResponse {
  preferences: UserPreferences;
}

export interface SaveResult {
  ok: boolean;
  error: string | null;
}

export interface UseUserPreferencesResult {
  prefs: UserPreferences | null;
  loading: boolean;
  /** Load error. Save errors come back on the SaveResult so a shared hook
   *  instance doesn't leak one section's error into another. */
  error: string | null;
  /** Persist a partial override. */
  save: (patch: Partial<UserPreferences>) => Promise<SaveResult>;
}

export function useUserPreferences(): UseUserPreferencesResult {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [loading, setLoading] = useState(true);
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
        setPrefs(body.preferences);
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

  async function save(patch: Partial<UserPreferences>): Promise<SaveResult> {
    try {
      const res = await apiFetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: patch }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<PrefsResponse> & { error?: string };
      if (!res.ok) return { ok: false, error: body.error ?? `Save failed (${res.status})` };
      if (body.preferences) setPrefs(body.preferences);
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  return { prefs, loading, error, save };
}
