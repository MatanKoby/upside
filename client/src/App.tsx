import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthGuard } from './components/common/AuthGuard';
import { BottomNav } from './components/common/BottomNav';
import { useMarketSession } from './hooks/useMarketSession';
import { subscribeToApiUrl } from './services/apiUrl';

export default function App() {
  // Subscribe once to Supabase Realtime on app_config so a rotating Quick
  // Tunnel URL propagates into our cache within ~500ms. The api URL itself
  // is resolved lazily by apiFetch on first call. Run pre-auth so the auth
  // POST itself benefits from the discovered URL.
  useEffect(() => subscribeToApiUrl(), []);

  return (
    <AuthGuard>
      <AuthedApp />
    </AuthGuard>
  );
}

function AuthedApp() {
  // Cached-first model: the portfolio renders regardless of IB session state.
  // The PortfolioHome header includes an IB status indicator (see
  // components/common/IbStatusIndicator) that lets the user connect/disconnect
  // on demand. No more full-screen "session expired" interruption.
  const session = useMarketSession();
  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet context={session} />
      </main>
      <BottomNav />
    </div>
  );
}
