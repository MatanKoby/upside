import { NavLink } from 'react-router-dom';
import { IconChartPie, IconBookmark, IconBell, IconSettings } from '@tabler/icons-react';

// Bottom nav per spec/screens/portfolio.md (post-2026-05-28 watchlist pivot):
// Portfolio · Watchlist · Settings. Alerts stays as a tab for now and migrates
// to a header bell in Batch 15 when the Alerts feed lands.
const TABS = [
  { to: '/',          label: 'Portfolio', Icon: IconChartPie, end: true  },
  { to: '/watchlist', label: 'Watchlist', Icon: IconBookmark, end: false },
  { to: '/alerts',    label: 'Alerts',    Icon: IconBell,     end: false },
  { to: '/settings',  label: 'Settings',  Icon: IconSettings, end: false },
];

export function BottomNav() {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="bottom-nav-tab">
          <Icon size={22} stroke={1.5} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
