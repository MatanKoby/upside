-- 023_universe_real_conid.sql — Batch S1.5.
--
-- Replaces the synthetic FNV-1a conid in `universe.conid` with a real
-- IBKR conid resolved via ibSecdefSearch (Client Portal API). Without
-- this, downstream batches' trait scoring can't join `intraday_stats`
-- and can't pull IB history per universe ticker.
--
-- `auto_promoted` is added in the same migration since both S1.5 (this
-- batch) and S2 (catalyst_reversal Stage-2) consume it. S1.5 just
-- creates the column; S2 sets it when catalyst Stage-2 promotes an
-- out-of-Ring-1 ticker into the day's curated list.
--
-- See spec/signals/screener-universe.md → Conid resolution.

alter table public.universe
  add column if not exists real_conid bigint,
  add column if not exists auto_promoted bool not null default false;

comment on column public.universe.real_conid is
  'IBKR conid resolved via ibSecdefSearch (null until resolved). Cross-table joins to IB-keyed data use this; the synthetic `conid` PK stays for in-table identity + idempotent universeCron re-runs.';
comment on column public.universe.auto_promoted is
  'true when catalyst_reversal Stage-2 promoted this ticker into Ring-1 for the day despite the standard filter rejecting it (e.g. previously thin-volume name now showing the volume-gap signature).';

-- Producer's claim query — "universe rows that need conid resolution".
-- Partial index keeps it cheap as the table grows.
create index if not exists universe_real_conid_pending_idx
  on public.universe(filter_result)
  where real_conid is null and filter_result = 'in';

-- Join-from-real_conid queries (intraday_stats lookup, history fetches).
create index if not exists universe_real_conid_idx
  on public.universe(real_conid)
  where real_conid is not null;
