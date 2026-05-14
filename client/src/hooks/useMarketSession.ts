import { useEffect, useState } from 'react';
import { apiFetch } from '../services/supabase';
import type { MarketPeriod } from '../types';

export type SessionStatus = 'connected' | 'disconnected' | 'expired';

export interface MarketSessionState {
  session: SessionStatus;
  marketPeriod: MarketPeriod;
  /** True when the FE hasn't yet successfully fetched any status. */
  isLoading: boolean;
  /** Last fetch failed at the network level (BE unreachable, etc.). */
  isOffline: boolean;
}

const POLL_INTERVAL_MS = 30_000;

export function useMarketSession(): MarketSessionState {
  const [state, setState] = useState<MarketSessionState>({
    session: 'expired',
    marketPeriod: 'closed',
    isLoading: true,
    isOffline: false,
  });

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const res = await apiFetch('/api/auth/status');
        if (!alive) return;
        if (!res.ok) {
          // 401 → user signed out; surface as expired. 5xx → treat as disconnected.
          setState((s) => ({
            ...s,
            session: res.status === 401 ? 'expired' : 'disconnected',
            isLoading: false,
            isOffline: false,
          }));
        } else {
          const body = await res.json();
          setState({
            session: body.session ?? 'expired',
            marketPeriod: body.marketPeriod ?? 'closed',
            isLoading: false,
            isOffline: false,
          });
        }
      } catch {
        if (!alive) return;
        setState((s) => ({ ...s, isOffline: true, isLoading: false }));
      } finally {
        if (alive) timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return state;
}
