-- Batch 13 — service_role grants for user-data tables.
--
-- 003_service_role_grants.sql covered server-only tables (access_attempts,
-- analysis_locks, contracts, ib_api_metrics). It missed positions, signals,
-- and user_preferences — user-data tables that the BE writes to from the
-- pricePoller / signal engine / preferences sync.
--
-- Symptom that surfaced this gap: pricePoller upsert into `positions`
-- returned "permission denied for table positions" even though the BE is
-- authenticated with the service_role key, because Data API
-- "auto-expose new tables" is OFF on this project. RLS bypass for
-- service_role doesn't help — PostgREST enforces the GRANT separately.

grant all on public.positions        to service_role;
grant all on public.signals          to service_role;
grant all on public.user_preferences to service_role;
