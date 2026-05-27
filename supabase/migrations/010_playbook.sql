-- 010_playbook.sql — Batch 14g
--
-- Single-direction playbook model. Replaces the unified SELL+BUY analysis
-- (Batch 14a) with one playbook per Analyze: a chosen direction (held → sell,
-- not-held → buy), a headline quality, and an ordered list of legs under one
-- horizon. Each analyze now persists exactly ONE `signals` row (down from 1-2),
-- which makes whole-analysis supersede trivially clean.
--
-- The columns from 008 are reused as-is:
--   signals.signal_type already allows 'sell' | 'buy' | 'no_signal' (no change).
--   signals.motivation check already keys off signal_type (sell vs buy enums).
--   signals.price_range_low / price_range_high / optimal_price hold leg[0]
--     (the immediate move) so the deferred range-notifications + accuracy
--     tracking keep working against the actionable price.
--
-- New here:
--   signals.playbook — the full ordered legs + horizon (the immediate move is
--     leg[0], mirrored into price_range_*/optimal_price above). Per-leg runtime
--     status (hit/missed/pending) is written onto this jsonb by Batch 14h's
--     live tracking.
--   analyses.refined_from_analysis_id — set by a Refine (Batch 14h) to link a
--     revised playbook back to the analysis it refined, so history shows the
--     chain. Null for a Fresh Analyze. Forward-declared here so 14h needs no
--     further migration.

-- The full playbook: { direction, signalQuality, motivation, horizon,
-- horizonWindow, legs: [{ action, price, condition, confidence, reasoning,
-- status?, actual? }] }. Null/absent on a no_signal row.
alter table public.signals
  add column if not exists playbook jsonb;

-- Refine chain pointer (Batch 14h). on delete set null so deleting a parent
-- analysis doesn't cascade-delete its refinements' history.
alter table public.analyses
  add column if not exists refined_from_analysis_id uuid
    references public.analyses(analysis_id) on delete set null;
