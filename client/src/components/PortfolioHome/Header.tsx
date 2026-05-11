import { IconMessageChatbot, IconBell, IconSettings } from '@tabler/icons-react';
import { MarketPeriodBadge } from './MarketPeriodBadge';
import type { MarketPeriod } from '../../types';

export function Header({ marketPeriod }: { marketPeriod: MarketPeriod }) {
  return (
    <header className="ph-header">
      <h1 className="ph-logo">Upside</h1>
      <div className="ph-header-right">
        <MarketPeriodBadge period={marketPeriod} />
        <button className="icon-btn" aria-label="Chat" type="button">
          <IconMessageChatbot size={20} stroke={1.5} />
        </button>
        <button className="icon-btn" aria-label="Notifications" type="button">
          <IconBell size={20} stroke={1.5} />
        </button>
        <button className="icon-btn" aria-label="Settings" type="button">
          <IconSettings size={20} stroke={1.5} />
        </button>
      </div>
    </header>
  );
}
