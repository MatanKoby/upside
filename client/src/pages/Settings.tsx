import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { useLlmConfig } from '../hooks/useLlmConfig';
import { useRiskFlagConfig, type RiskFlagConfig } from '../hooks/useRiskFlagConfig';
import { useUserPreferences, type UseUserPreferencesResult } from '../hooks/useUserPreferences';
import { useMarketSession } from '../hooks/useMarketSession';
import { IbStatusIndicator } from '../components/common/IbStatusIndicator';
import { getThemePref, applyTheme, type ThemePref } from '../services/theme';

// App-shell Settings screen (Batch 15). Composes the IB connection control, the
// profit-zone threshold, risk-flag thresholds, the analysis-engine picker,
// theme, and account. The signal-generation / Analyze-flow knobs live with the
// LLM-analysis track (spec/roadmap.md → Track 4 item 9), not here. Prefs that
// persist to user_preferences write through PUT /api/user/preferences (see the
// hooks); theme is a per-device localStorage concern. See spec/screens/settings.md.
//
// Security: this page only ever renders inside <AuthGuard> (authenticated +
// whitelisted — i.e. just the owner).
export default function Settings() {
  const [email, setEmail] = useState<string | null>(null);
  const prefs = useUserPreferences();

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null);
    });
  }, []);

  return (
    <div className="settings">
      <h1 className="settings-title">Settings</h1>

      <IbConnectionSection />
      <ProfitZoneSection prefs={prefs} />
      <RiskFlagsSettingsSection />
      <AnalysisEngineSection />
      <ThemeSection />
      <AccountSection email={email} />
    </div>
  );
}

// --- IB connection -------------------------------------------------------
// The IbStatusIndicator IS the connect/disconnect control (tappable). We give
// it its own market-session poller here since the Portfolio header (the other
// host) isn't mounted on this route.
function IbConnectionSection() {
  const { session, refresh } = useMarketSession();
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">IB connection</h2>
      <p className="settings-hint">
        Interactive Brokers gateway. Tap the indicator to connect or disconnect; connecting
        prompts 2FA on your phone.
      </p>
      <div className="settings-row">
        <span className="settings-label">Status</span>
        <IbStatusIndicator status={session} onChange={refresh} />
      </div>
    </section>
  );
}

// --- Profit-taking zone threshold ----------------------------------------
function ProfitZoneSection({ prefs }: { prefs: UseUserPreferencesResult }) {
  const { prefs: p, loading, save } = prefs;
  const [val, setVal] = useState(2);
  const [init, setInit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (p && !init) {
      setVal(p.profitZoneThresholdPct);
      setInit(true);
    }
  }, [p, init]);

  if (loading || !p) return <LoadingSection title="Profit-taking zone" />;

  const dirty = val !== p.profitZoneThresholdPct;

  async function onSave() {
    setBusy(true);
    setErr(null);
    const r = await save({ profitZoneThresholdPct: val });
    setBusy(false);
    if (r.ok) {
      setFlash(true);
      setTimeout(() => setFlash(false), 2000);
    } else setErr(r.error);
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Profit-taking zone</h2>
      <p className="settings-hint">
        A held position lands in the profit-taking zone once it's this far above your cost basis.
      </p>
      <label className="settings-row">
        <span className="settings-label">Threshold</span>
        <span className="settings-slider-wrap">
          <input
            className="settings-slider"
            type="range"
            min={0.5}
            max={10}
            step={0.5}
            value={val}
            onChange={(e) => setVal(Number(e.target.value))}
            aria-label="Profit-taking zone threshold (%)"
          />
          <span className="settings-value">{val.toFixed(1)}%</span>
        </span>
      </label>
      <button className="settings-button" onClick={() => void onSave()} disabled={busy || !dirty}>
        {busy ? 'Saving…' : flash ? 'Saved ✓' : 'Save'}
      </button>
      {err && <p className="settings-error">{err}</p>}
    </section>
  );
}

// --- Theme ---------------------------------------------------------------
// Per-device only (localStorage), applied immediately. The palette lives in
// styles/tokens.css; applyTheme just flips data-theme. See services/theme.ts.
function ThemeSection() {
  const [pref, setPref] = useState<ThemePref>(() => getThemePref());

  function onChange(next: ThemePref) {
    setPref(next);
    applyTheme(next);
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Theme</h2>
      <label className="settings-row">
        <span className="settings-label">Appearance</span>
        <select
          className="settings-select"
          value={pref}
          onChange={(e) => onChange(e.target.value as ThemePref)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </section>
  );
}

// --- Account -------------------------------------------------------------
function AccountSection({ email }: { email: string | null }) {
  const [busy, setBusy] = useState(false);

  async function onSignOut() {
    setBusy(true);
    // AuthGuard redirects to the login screen once the session clears.
    await supabase.auth.signOut();
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Account</h2>
      <p className="settings-row">
        <span className="settings-label">Signed in as</span>
        <span className="settings-value">{email ?? '—'}</span>
      </p>
      <button className="settings-button" onClick={() => void onSignOut()} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}

function LoadingSection({ title }: { title: string }) {
  return (
    <section className="settings-section">
      <h2 className="settings-section-title">{title}</h2>
      <p className="settings-hint">Loading…</p>
    </section>
  );
}

// LLM provider + model selector. Persists to Supabase app_config via the api so
// the choice takes effect on the next Analyze with no redeploy — and stays in
// sync across devices via Realtime (see useLlmConfig). API keys remain in the
// server .env; this only picks among providers that have a key configured.
function AnalysisEngineSection() {
  const { config, loading, saving, error, save } = useLlmConfig();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Seed the draft once from the loaded config; later Realtime reloads don't
  // clobber an in-progress edit.
  useEffect(() => {
    if (config && !initialized) {
      setProvider(config.provider);
      setModel(config.model ?? '');
      setInitialized(true);
    }
  }, [config, initialized]);

  if (loading) {
    return (
      <section className="settings-section">
        <h2 className="settings-section-title">Analysis engine</h2>
        <p className="settings-hint">Loading…</p>
      </section>
    );
  }

  const available = config?.available ?? [];
  // Always show the current provider even if its key was since removed.
  const options = Array.from(new Set([config?.provider, ...available].filter(Boolean))) as string[];
  const defaultModel = config?.provider === provider ? config?.defaultModel : '';
  const dirty = provider !== config?.provider || model !== (config?.model ?? '');

  async function onSave() {
    const ok = await save(provider, model.trim() || null);
    if (ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Analysis engine</h2>
      <p className="settings-hint">
        Which LLM runs an Analyze. Takes effect on the next analysis. Only providers with a
        key configured on the server are listed.
      </p>

      {available.length === 0 ? (
        <p className="settings-error">
          No LLM provider keys configured on the server. Set one (e.g. GROQ_API_KEY) in the
          api .env.
        </p>
      ) : (
        <>
          <label className="settings-row">
            <span className="settings-label">Provider</span>
            <select
              className="settings-select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel(''); // model is provider-specific — reset to default
              }}
            >
              {options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-row">
            <span className="settings-label">Model</span>
            <input
              className="settings-input"
              value={model}
              placeholder={defaultModel ? `${defaultModel} (default)` : 'provider default'}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Model (blank = provider default)"
            />
          </label>

          <button className="settings-button" onClick={() => void onSave()} disabled={saving || !dirty}>
            {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
          </button>
        </>
      )}
      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}

// Risk-flag thresholds (Batch R2) — the six tunables persisted to
// user_preferences.risk_flag_config via PUT /api/user/preferences. The engine
// re-reads them on the next nightly pass + at Analyze. Market-cap is edited in
// $M for legibility and stored back in raw USD.
function RiskField({
  label,
  value,
  step,
  min,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="settings-row">
      <span className="settings-label">{label}</span>
      <input
        className="settings-input"
        type="number"
        inputMode="decimal"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function RiskFlagsSettingsSection() {
  const { config, defaults, loading, saving, error, save } = useRiskFlagConfig();
  const [draft, setDraft] = useState<RiskFlagConfig | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    if (config && !draft) setDraft(config);
  }, [config, draft]);

  if (loading || !draft) {
    return (
      <section className="settings-section">
        <h2 className="settings-section-title">Risk flags</h2>
        <p className="settings-hint">Loading…</p>
      </section>
    );
  }

  const set = (k: keyof RiskFlagConfig, v: number) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const dirty =
    config != null &&
    (Object.keys(draft) as (keyof RiskFlagConfig)[]).some((k) => draft[k] !== config[k]);

  async function onSave() {
    const ok = await save(draft!);
    if (ok) {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }
  }

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Risk flags</h2>
      <p className="settings-hint">
        Thresholds for the danger flags shown on cards + ticker detail. Applied on the next
        nightly pass and at Analyze.
      </p>

      <RiskField label="Price surge ≥ (%)" value={draft.surgePct} step={1} min={1} onChange={(v) => set('surgePct', v)} />
      <RiskField label="…over (sessions)" value={draft.surgeWindowSessions} step={1} min={1} onChange={(v) => set('surgeWindowSessions', v)} />
      <RiskField label="Volume spike ≥ (× avg)" value={draft.volMult} step={0.5} min={1} onChange={(v) => set('volMult', v)} />
      <RiskField label="RSI overbought > " value={draft.rsiZ} step={1} min={50} onChange={(v) => set('rsiZ', v)} />
      <RiskField label="Near 52w-high within (%)" value={draft.near52wHighPct} step={1} min={0} onChange={(v) => set('near52wHighPct', v)} />
      <RiskField
        label="Micro-cap under ($M)"
        value={Math.round(draft.microCapUsd / 1_000_000)}
        step={50}
        min={1}
        onChange={(v) => set('microCapUsd', v * 1_000_000)}
      />
      <RiskField label="Earnings within (days)" value={draft.earningsDays} step={1} min={0} onChange={(v) => set('earningsDays', v)} />

      <div className="settings-actions">
        <button className="settings-button" onClick={() => void onSave()} disabled={saving || !dirty}>
          {saving ? 'Saving…' : savedFlash ? 'Saved ✓' : 'Save'}
        </button>
        {defaults && (
          <button
            className="settings-button"
            onClick={() => setDraft({ ...defaults })}
            disabled={saving}
            type="button"
          >
            Reset to defaults
          </button>
        )}
      </div>
      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
