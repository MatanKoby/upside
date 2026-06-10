# Async Job Queue

A Postgres-backed job queue that decouples **producers** (decide what work
is needed) from **workers** (pure executors), so all upstream-call
processes (IB, Finnhub, compute) run fully async and survive disconnects /
restarts without losing work.

Used by every cron that touches a rate-limited or intermittently-available
upstream — the existing pollers + screener-track batches (S0.5 / S1.5 / S2
/ S3) all migrate to this model. Replaces the per-cron `ibStatus()`-checks
+ silent-skip pattern that wastes IB-connection windows.

Sibling files: `architecture.md` (deployment topology), `schema.md` →
`screener_jobs` (the table), `flows.md` (per-cron flows now reference
producer/worker steps).

## Why

Single VPS, ~15-20 min/day of IB work spread across multiple crons, IB
connected only when the user isn't using IBKR Mobile (random windows).
Without a queue: each cron is a setTimeout loop that self-gates on
`ibStatus()`; misses IB-connection windows; wastes the rest of the cycle.
With a queue: producers post deduplicated work whenever; workers drain
when their upstream is available; long queues build during offline windows
and burn through fast when the upstream comes back.

The split is strict: **producers gate, workers execute.** A worker never
decides whether to retry or whether work is "still relevant" — it just
runs the job and reports outcome. The producer's next cycle interprets
outcomes and re-queues if its policy says so.

## Schema

One table: `screener_jobs`. See `schema.md` → `screener_jobs` for the
column-level definition. Critical bits:

```sql
job_key   text          -- deterministic dedup key: '<action>:<resource>:<params>'
                        -- examples:
                        --   resolve_conid:REPL_XNAS
                        --   refresh_intraday_stats:530965695:2026-05-31
                        --   eval_catalyst_stage1:530965695:2026-05-31

worker_pool text        -- 'ib' | 'finnhub' | 'compute'
status      text        -- 'queued' | 'claimed' | 'done' | 'failed'

-- THE dedup mechanism:
create unique index screener_jobs_active_key_idx
  on screener_jobs(job_key) where status in ('queued', 'claimed');
```

The **partial unique index** is the heart of dedup. `done` / `failed` rows
don't conflict, so tomorrow's "same work" can be re-enqueued; today's
duplicate enqueue from a producer-cycle-rerun is silently rejected.

## Producer pattern

Every producer (a cron, normally) follows the same three steps each cycle:

```pseudocode
1. compute_pending_work()       // business logic — read target tables,
                                // identify rows needing the action
                                // (e.g. universe rows with real_conid IS NULL)

2. for each candidate:
     job_key = make_key(action, resource, params)
     INSERT INTO screener_jobs(job_key, action, worker_pool, payload, …)
       ON CONFLICT (job_key) WHERE status IN ('queued','claimed') DO NOTHING

3. drain_completed()
     - SELECT WHERE status='done' AND action='<mine>'
         → delete (success path, work landed on target table)
     - SELECT WHERE status='failed' AND action='<mine>'
         → apply retry policy:
             - if attempts < cap AND not circuit-broken:
                 insert new row with same job_key (failed row no longer
                 in partial index, so insert succeeds); optionally
                 delete the failed row for cleanliness
             - else: finalize loss (delete + log to Discord); producer
                 accepts that this work won't run today
```

Producers **do not** touch claimed/in-flight jobs. The producer's view is
"what's pending vs completed"; in-flight state is the worker's affair.

## Worker pattern

Each worker pool runs as its own loop. The pool name decides upstream
gating, but per-job execution is identical:

```pseudocode
loop:
  if pool_gate_closed():       // IB disconnected for the 'ib' pool;
    sleep N seconds; continue   // Finnhub queue full for 'finnhub'; etc.

  job = atomic_claim_one(worker_pool=$pool, limit=1)
    -- SELECT id FROM screener_jobs
    --   WHERE worker_pool = $pool
    --     AND status = 'queued'
    --     AND scheduled_for <= now()
    --   ORDER BY priority DESC, created_at ASC
    --   FOR UPDATE SKIP LOCKED
    --   LIMIT 1
    -- UPDATE … SET status='claimed', claimed_at=now(),
    --              claimed_by=$worker_id,
    --              lease_expires_at=now()+LEASE_DURATION
    -- (both in one tx)

  if !job: sleep N seconds; continue

  try:
    result = execute(job.action, job.payload)
    write_result_to_target_table(result)
    UPDATE … SET status='done', completed_at=now()
  catch err:
    UPDATE … SET status='failed', last_error=err.message,
                 attempts=attempts+1,
                 completed_at=now()
    // worker stops; producer's next cycle decides re-queue
```

`SELECT … FOR UPDATE SKIP LOCKED` is Postgres's standard concurrent-queue
primitive — two workers polling at the same instant cannot double-claim.

## Worker pools

| Pool | Gates on | When idle |
| --- | --- | --- |
| `ib` | `ibStatus().connected && .authenticated` | Sleeps when IB is off. Drains long queue when user connects IB. **Built-in IB rate limit** (10 req/sec global + soft history pacing) enforced inside the pool — not the producer's concern. |
| `finnhub` | `finnhubQueue` capacity (50/min budget) | Always running. Per-(category, key) intervals already enforced by `finnhubQueue.request`. |
| `compute` | Always open | Pure CPU jobs (e.g. compute `intraday_low_pct` from already-fetched bars). Doesn't wait on upstream. |

The pool name lives on the job row so a single worker process can serve
multiple pools, or each pool can be its own process — implementation
choice. For MVP, one process per pool inside the api container is fine.

## Per-action preconditions (gates)

The pool gate above is **coarse** — it answers "is this upstream available at
all?" Some actions need a **finer, per-action precondition** the pool can't
express. The motivating case: `eval_catalyst_stage1` needs a *live RTH snapshot*
— IBKR field `7295` (today's open) only exists after the 09:30 ET open, so even
with the `ib` pool open the job **fails overnight/premarket** ("snapshot missing
price/open"). Without this layer the job runs the instant it's claimed and
fails, burning a retry attempt and polluting the failed set with work that was
never going to succeed *yet*.

So an action may declare a **gate** — a mechanical "can this run *now*?"
predicate, evaluated by the worker **after claim, before execute**:

```
gate(payload, ctx) → { ready: true }
                    | { ready: false, retryAt: timestamptz }
```

On `ready: false` the worker **defers** rather than fails:

- status → back to `queued`, `scheduled_for = retryAt`, and **`attempts` is NOT
  incremented**. A deferral is not a failure — it never reaches the producer's
  retry / give-up policy, so a name that's simply out-of-window doesn't get
  "given up" after N tries.
- The claim filter (`scheduled_for <= now()`) then naturally skips the job until
  the window opens; the pool drains it when IB reconnects inside that window
  (IB-connect → pool wakes → drains the now-eligible backlog).

Gates stay within the **producers-gate / workers-execute** split: a gate is
mechanical (like the pool gate), not business logic — the worker still never
decides whether the work is *relevant*, only whether its preconditions are
*met*. Gates compose with the pool gate (pool first, then per-action).

Gate kinds (v1): `requiresRthOpen` (defer to the next 09:30 ET if before open),
`requiresMarketOpen`, and a generic predicate slot for data-freshness
preconditions (e.g. "needs today's `daily_bars` row"). `catalyst_*` declares
`requiresRthOpen` — the fix for the overnight-fail (see
`signals/screener-universe.md` → catalyst_reversal). Every action that depends
on a specific timeframe or data-availability condition should declare its gate
rather than fail-and-retry into the void.

## Lifecycle

```
producer cycle ──► INSERT (queued)
                       │
                       ▼  ── worker SELECT FOR UPDATE SKIP LOCKED
                   claimed (lease N min)
                       │
       success ────────┼──────── failure
           │           │            │
           ▼           │            ▼
         done          │         failed
           │           │            │
           │           │            │
    producer drain ────┼──── producer drain
       (delete)        │       (retry decide:
                       │         → INSERT new row, same job_key
                       │         → OR delete + log loss)
                       │
                       ▼
                  reaper cron
              status='claimed' AND
              lease_expires_at < now()
                       │
                       ▼
                  status='failed'
                  last_error='lease expired'
                  (→ flows back to producer's retry decision)
```

## Failure modes covered

| Concern | Mechanism |
| --- | --- |
| Duplicate-queueing of same logical work | Partial unique index on `job_key` |
| Double-execution by parallel workers | `SELECT … FOR UPDATE SKIP LOCKED` |
| Worker crash mid-job | Lease + reaper cron flips to `failed` after `lease_expires_at` |
| Worker hung but alive (network stall) | Same lease/reaper path catches it |
| Cron / producer crash | Stateless producer — restart re-runs cycle from current target-table state, dedup index prevents pile-up |
| Long offline + reconnect storm | Producer cycles produce bounded work (size of target rows); worker drains rate-limited inside pool |
| Workers blocking on IB while user wants to use IB Mobile | Worker pool gates at pool level — disconnect detected on next poll, worker idles |
| Stale-data write (worker computed against pre-update read) | Each action owns its target-table columns; no cross-action conflict by partition. Within an action, the worker's write is keyed by the row PK and overwrites its own previous result (idempotent). |

## Dependencies between actions

Cross-stage dependencies (e.g. `eval_catalyst_stage1` must complete before
`eval_catalyst_stage2` for the same conid) are handled by **the producer**,
not a DAG in the queue:

- The catalyst producer's `compute_pending_work()` looks for
  `status='done' AND action='eval_catalyst_stage1' AND payload->>'conid'=$c`
  rows that don't yet have a corresponding Stage-2 job for today, and
  enqueues Stage-2 jobs.
- One **drain cycle** of latency between stages — trivially correct, no DAG
  complexity.

**Drain cadence vs. produce cadence (Batch X10.2).** The drain that advances a
stage runs on the producer's *cycle*, so stage latency = drain-cycle length, not
the natural enqueue cadence. For a nightly batch a single 24h tick that does
enqueue + drain together is fine. For an **intraday-relevant** pipeline it is
not: with one combined 24h tick, Stage-1→Stage-2→`trait_scores` takes 2-3 days.
So split the loops — keep the slow **produce** loop (recompute candidates +
enqueue, daily) but run a fast **advance** loop (drain done → enqueue next stage
→ write the target table; ~minutes) so the pipeline flows same-session. The
advance loop is DB-only (the rate-limited upstream calls stay in the gated
workers), so a tight cadence is cheap. `catalystReversalProducer` is the
reference (see `signals/screener-universe.md` → catalyst_reversal).

For "fan-out then fan-in" patterns (rare here), a producer can wait
multiple cycles for a set of jobs to complete before enqueueing the next
stage. The wait state lives in the producer's own logic, not the queue.

## Scheduling

`scheduled_for timestamptz` on each job — worker `WHERE scheduled_for <=
now()`. Lets a producer say "run this earnings-calendar job at 09:00 IDT
sharp" without bespoke cron timing. Default `now()` = "run as soon as a
worker is free."

`priority int` — higher fires earlier. Default 0. Producer can mark
user-initiated work (e.g. ad-hoc symbol resolve) at priority 100 to jump
the nightly batch.

## Retention

Done jobs are deleted by the producer's drain step. Failed jobs are
deleted when the producer's retry policy gives up. Reaper handles
lease-expired claimed jobs (flips to failed; producer drains).

Background retention sweep: delete any `status='done' OR status='failed'`
rows older than 7 days as a safety net. Should normally find nothing —
producers should be draining within their cadence.

## What this layer does NOT do

- **No external queue infra** — Postgres only. We add BullMQ / RabbitMQ /
  NATS only if/when Postgres-as-queue becomes a measured bottleneck (very
  unlikely at single-user scale).
- **No DAGs** — cross-stage dependencies live in producer logic (see above).
- **No graceful mid-flight cancellation** — an `ib` worker mid-call can't
  be interrupted. "Pause all IB work" is honored at the *next* worker
  poll, not in-flight.
- **No realtime worker observability dashboard** — query the table for
  status counts; Discord notifies on circuit-breaker trips and lease
  expirations. Real dashboard is a follow-up if needed.
- **No cross-process distributed coordination** — single VPS, single api
  container. The whole queue lives in one Postgres instance; workers are
  threads/processes inside the api.

## Follow-ups (post-MVP, when measurable need shows)

- Per-job-type circuit breaker (stop claiming a pool when failure-rate
  exceeds threshold) — current design assumes producers' retry policy is
  sane.
- Heartbeat / lease renewal for long-running jobs — current design
  assumes jobs complete within `LEASE_DURATION` (default 5 min). If a job
  legitimately needs longer, bump the default or add explicit renewal.
- Job-type usage metrics dashboard.
- Job-payload encryption (if we ever store user-secret-bearing payloads;
  not the case today).
