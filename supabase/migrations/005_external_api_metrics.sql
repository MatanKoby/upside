-- Batch 13.7 — rename ib_api_metrics → external_api_metrics; add provider column.
--
-- The original ib_api_metrics table was instrumented only for IB Client Portal
-- calls. With the Finnhub queue landing in Batch 13.7 (and Finnhub becoming the
-- second major external API the BE talks to), we generalize the table so both
-- providers' calls are auditable from the same place.
--
-- Existing rows are backfilled `provider = 'ib'`. The default is dropped after
-- backfill so future inserts must specify a provider explicitly — keeps
-- callers from accidentally writing untagged rows.

alter table public.ib_api_metrics rename to external_api_metrics;

alter table public.external_api_metrics
  add column if not exists provider text not null default 'ib';

-- Drop the default — callers must specify provider going forward.
alter table public.external_api_metrics alter column provider drop default;

-- Service-role grant followed the table through the rename, but re-grant
-- explicitly to be safe (idempotent; no-op if already present).
grant all on public.external_api_metrics to service_role;

-- Refresh / recreate indexes under the new name. Postgres renames indexes
-- automatically when a table is renamed via ALTER TABLE … RENAME, but the
-- legacy index names will keep the old "ib_api_metrics_*" prefix until we
-- explicitly rename them. Rename for clarity.
alter index if exists ib_api_metrics_endpoint_idx rename to external_api_metrics_endpoint_idx;
alter index if exists ib_api_metrics_captured_idx rename to external_api_metrics_captured_idx;

-- Useful additional index for filtering by provider when 13.9 tuning needs it.
create index if not exists external_api_metrics_provider_idx
  on public.external_api_metrics (provider, captured_at desc);
