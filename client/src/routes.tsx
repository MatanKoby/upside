import { createBrowserRouter } from 'react-router-dom';
import App from './App';
import PortfolioHome from './pages/PortfolioHome';
import ComingSoon from './pages/ComingSoon';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <PortfolioHome /> },
      { path: 'screener', element: <ComingSoon label="Screener" /> },
      { path: 'chat', element: <ComingSoon label="Chat" /> },
      { path: 'alerts', element: <ComingSoon label="Alerts" /> },
      { path: 'ticker/:symbol', element: <ComingSoon label="Ticker detail" showBack /> },
    ],
  },
]);
