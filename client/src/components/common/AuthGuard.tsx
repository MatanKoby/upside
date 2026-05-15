import { useEffect, useRef, useState, type ReactNode } from 'react';
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

const VERIFIED_TOKEN_STORAGE_KEY = 'upside_verified_token';

function readVerifiedToken(): string | null {
  try {
    return localStorage.getItem(VERIFIED_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeVerifiedToken(token: string): void {
  try {
    localStorage.setItem(VERIFIED_TOKEN_STORAGE_KEY, token);
  } catch {
    // localStorage unavailable (private mode etc.) — degrade silently.
  }
}

function clearVerifiedToken(): void {
  try {
    localStorage.removeItem(VERIFIED_TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  // Tracks the last access token we successfully verified. Persisted in
  // localStorage so a page reload with the same cached Supabase session
  // doesn't re-verify (and re-log) what we already accepted; reset on
  // sign-out. The BE still enforces requireAuth on every protected route,
  // so a stale local cache can't bypass authorization — it only suppresses
  // duplicate audit rows for the "same person, same token, fresh page" case.
  const verifiedTokenRef = useRef<string | null>(readVerifiedToken());

  useEffect(() => {
    let cancelled = false;

    async function verify(accessToken: string | undefined) {
      if (!accessToken) {
        verifiedTokenRef.current = null;
        clearVerifiedToken();
        if (!cancelled) setPhase('unauthenticated');
        return;
      }
      if (accessToken === verifiedTokenRef.current) {
        // Already verified this exact token — including across page reloads
        // since the ref is hydrated from localStorage on mount. Surface
        // 'authenticated' immediately in case we just rendered 'loading'.
        if (!cancelled) setPhase('authenticated');
        return;
      }
      // Optimistic claim: stake out the token synchronously, before the
      // await, so any other onAuthStateChange events firing for the same
      // token see it already claimed and bail out at their own check.
      // (A single OAuth sign-in fires INITIAL_SESSION + SIGNED_IN +
      // sometimes TOKEN_REFRESHED in rapid succession.) On verification
      // failure we roll back so the next event/retry can take another swing.
      const previousToken = verifiedTokenRef.current;
      verifiedTokenRef.current = accessToken;
      if (!cancelled) setPhase('verifying');
      try {
        const res = await apiFetch('/api/auth/google/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
        });
        if (cancelled) return;
        if (res.status === 403) {
          clearVerifiedToken();
          setPhase('denied');
          await supabase.auth.signOut();
          window.location.replace('https://google.com');
          return;
        }
        if (!res.ok) {
          verifiedTokenRef.current = previousToken;
          clearVerifiedToken();
          setError(`Auth verification failed (${res.status})`);
          setPhase('unauthenticated');
          await supabase.auth.signOut();
          return;
        }
        writeVerifiedToken(accessToken);
        setError(null);
        setPhase('authenticated');
      } catch (e: unknown) {
        if (cancelled) return;
        verifiedTokenRef.current = previousToken;
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
