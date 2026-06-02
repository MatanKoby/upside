// Vitest fixtures for the pure helpers in queue.ts (Batch S0.3).
//
// The async helpers (enqueue / claimNext / markDone / markFailed /
// markRetry) all hit Supabase + the Postgres functions defined in
// migration 021_screener_jobs.sql. Their semantics are exercised by the
// integration verification in BUILD_QUEUE.md → S0.3 (smoke + dedup +
// race + crash safety scenarios). The unit-testable surface here is the
// `makeKey` deterministic constructor.

import { describe, it, expect } from 'vitest';
import { makeKey } from './keys.js';

describe('makeKey', () => {
  it('joins action + parts with colons', () => {
    expect(makeKey('resolve_conid', 'REPL', 'XNAS')).toBe('resolve_conid:REPL:XNAS');
  });

  it('coerces numeric parts to strings', () => {
    expect(makeKey('refresh_intraday_stats', 530965695, '2026-05-31')).toBe(
      'refresh_intraday_stats:530965695:2026-05-31',
    );
  });

  it('is order-sensitive (different ordering → different key)', () => {
    expect(makeKey('a', 'x', 'y')).not.toBe(makeKey('a', 'y', 'x'));
  });

  it('action alone is a valid key (single-instance jobs)', () => {
    expect(makeKey('refresh_earnings_calendar')).toBe('refresh_earnings_calendar');
  });

  it('two identical calls yield the same key (dedup precondition)', () => {
    expect(makeKey('eval_catalyst_stage1', 12345, '2026-06-02')).toBe(
      makeKey('eval_catalyst_stage1', 12345, '2026-06-02'),
    );
  });
});
