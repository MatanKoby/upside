-- Batch 13.5 — entry-date tracking for positions.
--
-- `first_seen_at` is the canonical entry date Upside uses to compute days-held
-- and the %/day return metric. ibPricePoller stamps it on first sight of a
-- conid, then (best effort) overwrites with the date deduced from IB's
-- `/v1/api/pa/transactions` endpoint — walking the user's last 90 days of
-- fills for the most recent 0→non-zero transition, which is the true open of
-- the currently-held position.
--
-- `first_seen_source` records which path produced the date so the FE can
-- render honestly: 'ib_transactions' means it's exact; 'observed' means it's
-- a floor (the real entry happened on-or-before, but we can't prove how much
-- earlier). The floor case fires for positions opened more than 90 days ago
-- (outside IB's window) or when the poller stamps before the IB POST has
-- succeeded.
--
-- Existing rows: `first_seen_at` defaults to NULL. The next poll cycle
-- detects the NULL and runs the same first-sight logic against IB
-- transactions. Some pre-Upside positions opened within IB's window will
-- recover an exact date for free; older ones will fall back to the
-- observation timestamp.

alter table public.positions
  add column if not exists first_seen_at timestamptz null,
  add column if not exists first_seen_source text not null default 'observed';

alter table public.positions
  drop constraint if exists positions_first_seen_source_check;
alter table public.positions
  add constraint positions_first_seen_source_check
  check (first_seen_source in ('observed', 'ib_transactions'));
