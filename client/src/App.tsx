import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthGuard } from './components/common/AuthGuard';
import { BottomNav } from './components/common/BottomNav';
import { IBReconnectBlock } from './components/common/IBReconnectBlock';
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
  const session = useMarketSession();

  // IB session expired → full-screen reconnect prompt. Cached data is not
  // shown beneath the block — IB session must be restored before portfolio
  // is visible.
  if (!session.isLoading && session.session === 'expired') {
    return (
      <div className="app-shell">
        <main className="app-main">
          <IBReconnectBlock onReconnected={() => window.location.reload()} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet context={session} />
      </main>
      <BottomNav />
    </div>
  );
}
