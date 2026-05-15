import { useEffect, useState, type ReactNode } from 'react';
import { supabase, apiFetch } from '../../services/supabase';
import Login from '../../pages/Login';

// Wraps the app shell with auth state. Flow:
//   1. Resolve Supabase session (cached locally by supabase-js).
//   2. With a session, POST /api/auth/google/callback so the BE checks the
//      email against UPSIDE_ALLOWED_EMAILS and logs the attempt.
//   3. On not_whitelisted (403), sign out + redirect to google.com (per spec:
//      inconspicuous bounce, no Upside branding leaks to non-whitelisted users).
//   4. On success, render children.
//
// We re-run the whitelist check whenever the auth state changes (sign-in,
// sign-out, token refresh) so a granted decision is bound to a real Supabase
// session, not just a stored verification flag.

type Phase = 'loading' | 'unauthenticated' | 'verifying' | 'authenticated' | 'denied';

export function AuthGuard({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function verify(accessToken: string | undefined) {
      if (!accessToken) {
        if (!cancelled) setPhase('unauthenticated');
        return;
      }
      if (!cancelled) setPhase('verifying');
      try {
        const res = await apiFetch('/api/auth/google/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
        });
        if (cancelled) return;
        if (res.status === 403) {
          setPhase('denied');
          await supabase.auth.signOut();
          window.location.replace('https://google.com');
          return;
        }
        if (!res.ok) {
          setError(`Auth verification failed (${res.status})`);
          setPhase('unauthenticated');
          await supabase.auth.signOut();
          return;
        }
        setError(null);
        setPhase('authenticated');
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('unauthenticated');
      }
    }

    // Initial session check.
    void supabase.auth.getSession().then(({ data }) => {
      void verify(data.session?.access_token);
    });

    // Subsequent auth state changes (sign in, sign out, token refresh).
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      void verify(session?.access_token);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (phase === 'loading' || phase === 'verifying' || phase === 'denied') {
    return (
      <div className="auth-loading">
        <div className="auth-spinner" />
      </div>
    );
  }

  if (phase === 'unauthenticated') {
    return (
      <>
        <Login />
        {error && <p className="login-error">{error}</p>}
      </>
    );
  }

  return <>{children}</>;
}
