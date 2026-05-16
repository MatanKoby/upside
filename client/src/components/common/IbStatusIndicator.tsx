// Header indicator for the IB Gateway connection state. Tappable: starts or
// stops the IBeam container based on current state. See UPSIDE_MVP_SPEC.md
// → "IB Authentication Flow" for the broader design.

import { useState } from 'react';
import { apiFetch } from '../../services/supabase';
import type { SessionStatus } from '../../hooks/useMarketSession';

interface Props {
  status: SessionStatus;
  /**
   * Called after a successful connect/disconnect so the parent can kick
   * useMarketSession's poller into fast mode and reflect the transition.
   */
  onChange?: () => void;
}

export function IbStatusIndicator({ status, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Disable taps while busy, while connecting (already in flight), or while
  // disconnected (the BE polls — user can't speed that up).
  const tappable = !busy && (status === 'stopped' || status === 'connected' || status === 'expired');

  async function onTap() {
    if (!tappable) return;
    setError(null);
    setBusy(true);
    try {
      const path =
        status === 'connected'
          ? '/api/auth/ib/disconnect'
          : '/api/auth/ib/connect';
      const res = await apiFetch(path, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Failed (${res.status})`);
        return;
      }
      onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const label = labelFor(status, busy);

  return (
    <button
      type="button"
      className={`ib-status ib-status-${status}`}
      onClick={onTap}
      disabled={!tappable}
      aria-label={`IB ${status}. Tap to ${status === 'connected' ? 'disconnect' : 'connect'}.`}
      title={error ?? undefined}
    >
      <span className="ib-status-dot" />
      <span className="ib-status-label">{label}</span>
    </button>
  );
}

function labelFor(status: SessionStatus, busy: boolean): string {
  if (busy) return 'Working…';
  switch (status) {
    case 'connected':
      return 'IB live';
    case 'connecting':
      return 'Approve 2FA on IB Key';
    case 'disconnected':
      return 'Reconnecting…';
    case 'expired':
      return 'Reconnect IB';
    case 'stopped':
      return 'Connect IB';
  }
}
