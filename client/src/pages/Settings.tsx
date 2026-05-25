import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';
import { useLlmConfig } from '../hooks/useLlmConfig';

// Minimal Settings screen. For now it carries the account identity + a
// developer tool to copy the current access token (JWT) for API debugging.
// Batch 15 fleshes this out (IB connection, signal thresholds, theme, etc.).
//
// Security: this page only ever renders inside <AuthGuard> (authenticated +
// whitelisted — i.e. just the owner). The JWT is read from the live Supabase
// session at click time; it is not baked into the bundle and does not exist
// for an unauthenticated visitor (getSession() returns null), so there is
// nothing here for a non-authenticated user to reach or copy.
export default function Settings() {
  const [email, setEmail] = useState<string | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null);
      setHasToken(Boolean(data.session?.access_token));
    });
  }, []);

  async function copyToken() {
    // Read the freshest token at click time — it may have auto-refreshed since
    // mount. No session → nothing to copy (shouldn't happen behind AuthGuard).
    const { data } = await supabase.auth.getSession();
    const jwt = data.session?.access_token;
    if (!jwt) {
      setStatus('error');
      return;
    }
    try {
      await navigator.clipboard.writeText(jwt);
      setStatus('copied');
      setRevealed(null);
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      // Clipboard API blocked (non-secure context / permissions) — reveal the
      // token in a read-only field so it can be selected and copied manually.
      setRevealed(jwt);
      setStatus('error');
    }
  }

  return (
    <div className="settings">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-section">
        <h2 className="settings-section-title">Account</h2>
        <p className="settings-row">
          <span className="settings-label">Signed in as</span>
          <span className="settings-value">{email ?? '—'}</span>
        </p>
      </section>

      <AnalysisEngineSection />

      <section className="settings-section">
        <h2 className="settings-section-title">Developer</h2>
        <p className="settings-hint">
          Copy your current access token (JWT) for API debugging. Expires in ~1&nbsp;hour —
          re-copy when calls start returning 401.
        </p>
        <button
          className="settings-button"
          onClick={() => void copyToken()}
          disabled={!hasToken}
        >
          {status === 'copied' ? 'Copied ✓' : 'Copy access token'}
        </button>
        {revealed && (
          <input
            className="settings-token-field"
            readOnly
            value={revealed}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Access token — select to copy"
          />
        )}
        {status === 'error' && !revealed && (
          <p className="settings-error">No active session token to copy.</p>
        )}
      </section>
    </div>
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
