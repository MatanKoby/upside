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

  // Tappable in any state except when we're already in flight on an action,
  // or sitting in the transient 'disconnected' (BE is auto-recovering — user
  // can't speed it up). Notably, 'connecting' IS tappable: lets the user
  // cancel a login they missed (e.g., didn't approve 2FA in time) and start
  // fresh.
  const tappable = !busy && status !== 'disconnected';

  async function onTap() {
    if (!tappable) return;
    setError(null);
    setBusy(true);
    try {
      // 'connected' or 'connecting' → stop the container. In connecting,
      //   this cancels the in-flight login (e.g., missed 2FA) — explicit
      //   stop, no auto-retry. User decides whether to tap Connect again.
      // 'stopped' / 'expired' → start it (connect).
      const path =
        status === 'connected' || status === 'connecting'
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
      return 'Awaiting 2FA · tap to cancel';
    case 'disconnected':
      return 'Reconnecting…';
    case 'expired':
      return 'Reconnect IB';
    case 'stopped':
      return 'Connect IB';
  }
}
