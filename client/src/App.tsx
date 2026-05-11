import { Outlet } from 'react-router-dom';
import { BottomNav } from './components/common/BottomNav';

export default function App() {
  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
