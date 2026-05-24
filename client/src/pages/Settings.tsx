import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

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
