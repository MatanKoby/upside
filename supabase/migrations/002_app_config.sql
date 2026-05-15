-- Batch 11 — runtime config table for self-healing Quick Tunnel.
--
-- The FE reads `api_url` from this table on bootstrap (and via Realtime
-- subscription) to discover the api's current Cloudflare Quick Tunnel URL.
-- The tunnel watcher in the api (server/src/services/tunnelWatcher.ts)
-- upserts the value whenever cloudflared assigns a new URL.
--
-- See UPSIDE_MVP_SPEC.md → "Public URL Discovery (self-healing Quick Tunnel)".

create table if not exists public.app_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- ============================================================================
-- Row Level Security.
--
-- app_config is public read (the api URL is not a secret — auth is enforced
-- server-side on each route). Writes are restricted to the service role.
-- ============================================================================
alter table public.app_config enable row level security;

create policy "app_config: public read"
  on public.app_config
  for select
  using (true);

-- ============================================================================
-- Grants for the Data API roles.
--
-- anon needs select for the pre-login bootstrap (FE fetches api_url before
-- the user signs in). authenticated also needs select for the same reason.
-- service_role needs explicit grants because this project has Data API
-- "auto-expose new tables" OFF — without this, even the BE's secret key gets
-- "permission denied" on insert/update via PostgREST.
-- ============================================================================
grant select on public.app_config to anon, authenticated;
grant all    on public.app_config to service_role;

-- ============================================================================
-- Realtime — FE subscribes for url changes so a tunnel restart propagates
-- within seconds without polling.
-- ============================================================================
alter publication supabase_realtime add table public.app_config;
