import { Outlet } from 'react-router-dom';
import { BottomNav } from './components/common/BottomNav';
import { IBReconnectBlock } from './components/common/IBReconnectBlock';
import { useMarketSession } from './hooks/useMarketSession';

export default function App() {
  const session = useMarketSession();

  // Session expired → full-screen reconnect prompt. Caches data are not shown
  // beneath the block — session must be restored before portfolio is visible.
  // (When Batch 12 lands, Supabase-unauthenticated state is also caught here
  // and routes to the Google sign-in screen instead.)
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
