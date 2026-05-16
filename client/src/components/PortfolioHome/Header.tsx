import { Link } from 'react-router-dom';
import { IconBell, IconSettings } from '@tabler/icons-react';
import { MarketPeriodBadge } from './MarketPeriodBadge';
import { IbStatusIndicator } from '../common/IbStatusIndicator';
import type { MarketPeriod } from '../../types';
import type { SessionStatus } from '../../hooks/useMarketSession';

export function Header({
  marketPeriod,
  sessionStatus,
  onIbChange,
}: {
  marketPeriod: MarketPeriod;
  sessionStatus: SessionStatus;
  /** Called after a successful Connect/Disconnect tap. */
  onIbChange?: () => void;
}) {
  return (
    <header className="ph-header">
      <h1 className="ph-logo">Upside</h1>
      <div className="ph-header-right">
        <IbStatusIndicator status={sessionStatus} onChange={onIbChange} />
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
