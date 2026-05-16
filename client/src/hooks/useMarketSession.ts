import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/supabase';
import type { MarketPeriod } from '../types';

export type SessionStatus = 'stopped' | 'connecting' | 'connected' | 'disconnected' | 'expired';

export interface MarketSessionState {
  session: SessionStatus;
  marketPeriod: MarketPeriod;
  /** True when the FE hasn't yet successfully fetched any status. */
  isLoading: boolean;
  /** Last fetch failed at the network level (BE unreachable, etc.). */
  isOffline: boolean;
  /**
   * Force a refresh now AND switch the poller to fast mode (~3s) until the
   * session settles into a stable state. Called right after the FE issues
   * a connect or disconnect so the UI reflects the transition quickly.
   */
  refresh: () => void;
}

const STEADY_POLL_MS = 30_000;
const FAST_POLL_MS = 3_000;
/** While in these states the poller stays in fast mode. */
const TRANSIENT_STATES: ReadonlySet<SessionStatus> = new Set([
  'connecting',
  'disconnected',
]);

export function useMarketSession(): MarketSessionState {
  const [state, setState] = useState<Omit<MarketSessionState, 'refresh'>>({
    session: 'stopped',
    marketPeriod: 'closed',
    isLoading: true,
    isOffline: false,
  });
  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Caller-side trigger: bumping this kicks the effect into running tick()
  // immediately instead of waiting for the next scheduled poll.
  const [forceTick, setForceTick] = useState(0);

  const refresh = useCallback(() => setForceTick((n) => n + 1), []);

  useEffect(() => {
    aliveRef.current = true;

    async function tick(): Promise<void> {
      try {
        const res = await apiFetch('/api/auth/status');
        if (!aliveRef.current) return;
        if (!res.ok) {
          setState((s) => ({
            ...s,
            session: res.status === 401 ? 'expired' : 'disconnected',
            isLoading: false,
            isOffline: false,
          }));
        } else {
          const body = (await res.json()) as { session?: SessionStatus; marketPeriod?: MarketPeriod };
          const nextSession = body.session ?? 'stopped';
          setState({
            session: nextSession,
            marketPeriod: body.marketPeriod ?? 'closed',
            isLoading: false,
            isOffline: false,
          });
        }
      } catch {
        if (!aliveRef.current) return;
        setState((s) => ({ ...s, isOffline: true, isLoading: false }));
      } finally {
        if (aliveRef.current) {
          // Schedule next poll using the latest known state to decide cadence.
          // We can't read state directly here (stale closure) — peek via setState.
          setState((s) => {
            const nextDelay = TRANSIENT_STATES.has(s.session) ? FAST_POLL_MS : STEADY_POLL_MS;
            timerRef.current = setTimeout(tick, nextDelay);
            return s;
          });
        }
      }
    }

    void tick();
    return () => {
      aliveRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [forceTick]);

  return { ...state, refresh };
}
