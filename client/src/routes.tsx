import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import PortfolioHome from './pages/PortfolioHome';
import ComingSoon from './pages/ComingSoon';
import TickerDetailPage from './pages/TickerDetailPage';
import Settings from './pages/Settings';

// MVP routes per spec: portfolio (index), ticker detail, alerts, settings.
// Alerts renders a ComingSoon placeholder here; Batch 15 replaces it (and
// expands Settings) with the full screens. Settings is live now with a
// minimal account + developer (copy-JWT) surface.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true,            element: <PortfolioHome /> },
      { path: 'ticker/:symbol', element: <TickerDetailPage /> },
      { path: 'alerts',         element: <ComingSoon label="Alerts" /> },
      { path: 'settings',       element: <Settings /> },
    ],
  },
]);
