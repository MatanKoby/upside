import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import PortfolioHome from './pages/PortfolioHome';
import ComingSoon from './pages/ComingSoon';
import TickerDetailPage from './pages/TickerDetailPage';

// MVP routes per spec: portfolio (index), ticker detail, alerts, settings.
// Alerts + Settings render ComingSoon placeholders here; Batch 15 replaces
// them with real screens.
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true,            element: <PortfolioHome /> },
      { path: 'ticker/:symbol', element: <TickerDetailPage /> },
      { path: 'alerts',         element: <ComingSoon label="Alerts" /> },
      { path: 'settings',       element: <ComingSoon label="Settings" /> },
    ],
  },
]);
