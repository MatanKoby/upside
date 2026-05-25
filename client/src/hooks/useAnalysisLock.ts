import { useEffect, useState } from 'react';
import { supabase } from '../services/supabase';

// Subscribes to `analysis_locks` for the active (user, symbol) so the Analyze
// button can disable while an analysis is running anywhere (Realtime broadcasts
// the lock to every connected client). See signal-model.md → Concurrency lock.
export function useAnalysisLock(symbol: string | undefined): { isLocked: boolean } {
  const [isLocked, setIsLocked] = useState(false);

  useEffect(() => {
    if (!symbol) {
      setIsLocked(false);
      return;
    }
    const sym = symbol.toUpperCase();
    let alive = true;

    async function load() {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) {
        if (alive) setIsLocked(false);
        return;
      }
      const { data } = await supabase
        .from('analysis_locks')
        .select('id')
        .eq('user_id', userId)
        .eq('symbol', sym)
        .eq('status', 'running')
        .maybeSingle();
      if (alive) setIsLocked(!!data);
    }

    void load();

    const channel = supabase
      .channel(`analysis-locks-${sym}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'analysis_locks' }, () => {
        void load();
      })
      .subscribe();

    return () => {
      alive = false;
      void supabase.removeChannel(channel);
    };
  }, [symbol]);

  return { isLocked };
}
