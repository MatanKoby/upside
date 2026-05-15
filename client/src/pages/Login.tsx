import { useState } from 'react';
import { supabase } from '../services/supabase';

// Pre-auth screen. Per spec, no Upside branding is visible here — keep
// this intentionally bland so a non-whitelisted Gmail user who lands on the
// app (and will be bounced after Google sign-in) doesn't learn what Upside
// is. The button is the only interactive element.
export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
    // On success the browser is navigated away to Google; nothing else to do.
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <button
          type="button"
          className="login-google-button"
          onClick={handleSignIn}
          disabled={busy}
        >
          {busy ? 'Redirecting…' : 'Continue with Google'}
        </button>
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}
