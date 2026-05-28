import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import PortfolioHome from './pages/PortfolioHome';
import ComingSoon from './pages/ComingSoon';
import TickerDetailPage from './pages/TickerDetailPage';
import Settings from './pages/Settings';
import Watchlist from './pages/Watchlist';

// Routes per spec. Post-2026-05-28 watchlist pivot adds /watchlist.
// Alerts still renders ComingSoon — Batch 15 wires the feed.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true,            element: <PortfolioHome /> },
      { path: 'ticker/:symbol', element: <TickerDetailPage /> },
      { path: 'watchlist',      element: <Watchlist /> },
      { path: 'alerts',         element: <ComingSoon label="Alerts" /> },
      { path: 'settings',       element: <Settings /> },
    ],
  },
]);
