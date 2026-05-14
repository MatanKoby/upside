import { Link } from 'react-router-dom';
import { IconBell, IconSettings } from '@tabler/icons-react';
import { MarketPeriodBadge } from './MarketPeriodBadge';
import type { MarketPeriod } from '../../types';
import type { SessionStatus } from '../../hooks/useMarketSession';

export function Header({
  marketPeriod,
  sessionStatus,
}: {
  marketPeriod: MarketPeriod;
  sessionStatus: SessionStatus;
}) {
  return (
    <header className="ph-header">
      <h1 className="ph-logo">Upside</h1>
      <div className="ph-header-right">
        <ConnectionDot status={sessionStatus} />
        <MarketPeriodBadge period={marketPeriod} />
        <Link to="/alerts" className="icon-btn" aria-label="Alerts">
          <IconBell size={20} stroke={1.5} />
        </Link>
        <Link to="/settings" className="icon-btn" aria-label="Settings">
          <IconSettings size={20} stroke={1.5} />
        </Link>
      </div>
    </header>
  );
}

function ConnectionDot({ status }: { status: SessionStatus }) {
  const label =
    status === 'connected' ? '' :
    status === 'disconnected' ? 'Reconnecting…' :
    'Session expired';
  return (
    <span className={`connection-dot connection-dot-${status}`} aria-label={`IB session ${status}`}>
      <span className="connection-dot-circle" />
      {label && <span className="connection-dot-label">{label}</span>}
    </span>
  );
}
