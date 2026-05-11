import { NavLink } from 'react-router-dom';
import { IconChartPie, IconSearch, IconMessageChatbot, IconBell } from '@tabler/icons-react';

const TABS = [
  { to: '/', label: 'Portfolio', Icon: IconChartPie, end: true },
  { to: '/screener', label: 'Screener', Icon: IconSearch, end: false },
  { to: '/chat', label: 'Chat', Icon: IconMessageChatbot, end: false },
  { to: '/alerts', label: 'Alerts', Icon: IconBell, end: false },
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
