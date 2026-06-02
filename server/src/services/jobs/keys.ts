// Job-key constructor for the async job queue (Batch S0.3).
//
// Lives in its own file (separate from queue.ts) so vitest can exercise
// the pure-function surface without loading supabase + env at module
// init. See spec/job-queue.md for the role of `job_key` in producer
// dedup (it's the value the partial unique index is keyed on).

/**
 * Build the deterministic dedup key from an action + ordered parts.
 *
 *   makeKey('resolve_conid', 'REPL', 'XNAS')                  → 'resolve_conid:REPL:XNAS'
 *   makeKey('refresh_intraday_stats', 530965695, '2026-05-31') → 'refresh_intraday_stats:530965695:2026-05-31'
 *
 * Parts are coerced to strings + joined with ':'. Producers pick parts
 * that uniquely identify the (action, resource, params) tuple so
 * concurrent producer cycles silently dedup against in-flight work.
 */
export function makeKey(action: string, ...parts: Array<string | number>): string {
  return [action, ...parts.map(String)].join(':');
}
