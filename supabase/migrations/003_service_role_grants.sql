-- Batch 12 — explicit service_role grants for server-only tables.
--
-- This Supabase project has Data API "auto-expose new tables" OFF, so the
-- service_role does NOT auto-bypass grants via PostgREST — it needs explicit
-- grants per table. 001_initial.sql incorrectly assumed service_role would
-- bypass automatically (a fair assumption against vanilla Supabase, but not
-- against a hardened "auto-expose OFF" project).
--
-- Surfaced over time as silent insert failures + "permission denied" errors:
--   - Batch 11: app_config writes (fixed in 002 with the same pattern)
--   - Batch 10–11: signalRunner cleanup on analysis_locks every 30s
--   - Batch 12: access_attempts inserts in /api/auth/google/callback,
--               silently failing with no log entries appearing
--
-- access_attempts, analysis_locks, contracts, ib_api_metrics are server-only
-- (no FE access intended), so they only need service_role grants — no
-- anon/authenticated grants.

grant all on public.access_attempts to service_role;
grant all on public.analysis_locks  to service_role;
grant all on public.contracts       to service_role;
grant all on public.ib_api_metrics  to service_role;
