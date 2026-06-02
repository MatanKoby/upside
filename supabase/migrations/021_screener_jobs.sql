-- 021_screener_jobs.sql — Batch S0.3.
--
-- Postgres-backed async job queue for the screener track + future
-- IB/Finnhub-touching processes. See spec/job-queue.md for the full
-- design rationale; schema.md → screener_jobs for the column-level spec.
--
-- Producers (cron schedulers) enqueue deduplicated jobs via
-- `enqueue_job(...)`. Workers (per pool: ib | finnhub | compute) claim
-- with `claim_next_job(...)` using FOR UPDATE SKIP LOCKED so concurrent
-- workers can't double-claim. The partial unique index on `job_key` is
-- the dedup mechanism — only active (queued | claimed) rows participate,
-- so tomorrow's "same work" can re-enqueue successfully.

create table if not exists public.screener_jobs (
  id                  uuid          primary key default extensions.uuid_generate_v4(),

  -- Deterministic dedup key, e.g. 'resolve_conid:REPL_XNAS' or
  -- 'refresh_intraday_stats:530965695:2026-05-31'.
  job_key             text          not null,

  -- Routing
  action              text          not null,
  worker_pool         text          not null check (worker_pool in ('ib','finnhub','compute')),

  -- Worker-readable payload (worker never writes it back).
  payload             jsonb         not null default '{}'::jsonb,

  -- Lifecycle
  status              text          not null default 'queued'
                                    check (status in ('queued','claimed','done','failed')),

  -- Scheduling
  priority            int           not null default 0,
  scheduled_for       timestamptz   not null default now(),

  -- Claim metadata
  claimed_at          timestamptz,
  claimed_by          text,
  lease_expires_at    timestamptz,

  -- Outcome
  attempts            int           not null default 0,
  last_error          text,

  -- Timestamps
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  completed_at        timestamptz
);

-- THE dedup mechanism: only active (queued | claimed) rows participate
-- in the unique index, so done/failed rows don't block re-enqueue.
create unique index if not exists screener_jobs_active_key_idx
  on public.screener_jobs(job_key)
  where status in ('queued','claimed');

-- Worker's claim query orders by priority desc, created_at asc on the
-- pool's queued rows where scheduled_for has arrived. This index covers
-- that ordering directly.
create index if not exists screener_jobs_claim_idx
  on public.screener_jobs(worker_pool, status, priority desc, created_at)
  where status = 'queued';

-- Producer's drain queries (status='done' | 'failed' filtered by action)
-- and the retention sweep both benefit from this.
create index if not exists screener_jobs_drain_idx
  on public.screener_jobs(action, status, completed_at);

-- Reaper's lease-expired query.
create index if not exists screener_jobs_lease_idx
  on public.screener_jobs(lease_expires_at)
  where status = 'claimed';

-- Service-role-only access; no FE consumer, no Realtime publication.
grant select, insert, update, delete on public.screener_jobs to service_role;

-- ---------------------------------------------------------------------------
-- enqueue_job — producer-facing INSERT … ON CONFLICT DO NOTHING that returns
-- 'created' or 'deduped' so the caller can tell whether the row landed.
-- Wrapping it in a function gives a single round-trip + a stable return
-- contract for the supabase-js .rpc() caller.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_job(
  p_job_key       text,
  p_action        text,
  p_worker_pool   text,
  p_payload       jsonb       default '{}'::jsonb,
  p_priority      int         default 0,
  p_scheduled_for timestamptz default now()
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted_id uuid;
begin
  insert into public.screener_jobs(
    job_key, action, worker_pool, payload, priority, scheduled_for
  ) values (
    p_job_key, p_action, p_worker_pool, p_payload, p_priority, p_scheduled_for
  )
  on conflict do nothing
  returning id into v_inserted_id;

  if v_inserted_id is not null then
    return 'created';
  end if;
  return 'deduped';
end;
$$;

grant execute on function public.enqueue_job(text, text, text, jsonb, int, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- claim_next_job — worker-facing atomic claim. SELECT FOR UPDATE SKIP LOCKED
-- inside a transaction guarantees two workers can't double-claim, and the
-- UPDATE-RETURNING gives the worker everything it needs in one round trip.
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_job(
  p_worker_pool   text,
  p_worker_id     text,
  p_lease_seconds int default 300
) returns public.screener_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
  v_row    public.screener_jobs;
begin
  -- Two-step: lock-and-pick the id, then UPDATE-RETURNING to fully populate
  -- the row. The single SELECT … FOR UPDATE SKIP LOCKED owns the lock
  -- for the duration of this txn (until COMMIT below).
  select id into v_job_id
  from public.screener_jobs
  where worker_pool   = p_worker_pool
    and status        = 'queued'
    and scheduled_for <= now()
  order by priority desc, created_at asc
  for update skip locked
  limit 1;

  if v_job_id is null then
    return null;
  end if;

  update public.screener_jobs
  set status           = 'claimed',
      claimed_at       = now(),
      claimed_by       = p_worker_id,
      lease_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
      updated_at       = now()
  where id = v_job_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.claim_next_job(text, text, int) to service_role;
