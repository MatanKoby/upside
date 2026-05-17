import { NavLink } from 'react-router-dom';
import { IconChartPie, IconBell, IconSettings } from '@tabler/icons-react';

// MVP nav per spec: Portfolio, Alerts, Settings.
// Screener / Chat / Watchlist are post-MVP (see UPSIDE_MVP_SPEC.md →
// "Post-MVP" priority list); explicitly not surfaced from the bottom nav.
const TABS = [
  { to: '/',         label: 'Portfolio', Icon: IconChartPie, end: true  },
  { to: '/alerts',   label: 'Alerts',    Icon: IconBell,     end: false },
  { to: '/settings', label: 'Settings',  Icon: IconSettings, end: false },
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
