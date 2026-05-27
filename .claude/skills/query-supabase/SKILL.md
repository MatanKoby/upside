---
name: query-supabase
description: Run read-only SQL against the Upside Supabase Postgres DB from this repo via psql. Use when you need to inspect live data — positions, signals, analyses, external_api_metrics, app_config, user_preferences — e.g. verifying a batch's effect, checking what the pollers wrote, or debugging. Read-only (SELECT only); writes are denied, so it is safe to run freely.
---

# Query the Upside Supabase DB (read-only)

Direct `psql` access to the production Supabase Postgres as the `upside_readonly`
role. The role is SELECT-only (writes return `permission denied`), so queries are
safe to run without confirmation.

## How to run a query

The connection string lives in the gitignored `.secrets/readonly-db` file
(repo-root-relative). **Never print it** — it contains a password. Pass it to psql via command
substitution so the secret never lands in the command text or output:

```bash
psql "$(cat .secrets/readonly-db)" -P pager=off -c "select symbol, current_price, price_source from positions order by symbol;"
```

- `-P pager=off` — stops psql blocking on an interactive pager.
- `-tAc` — tab-separated, unaligned, tuples-only; best when you want to parse output.
- Multiple statements: repeat `-c`, or use `-f file.sql`.

Quick sanity check that access works:

```bash
psql "$(cat .secrets/readonly-db)" -tAc "select current_user;"   # → upside_readonly
```

## Connection details (reference / if the creds file is lost)

- Role: `upside_readonly` (LOGIN, SELECT-only on `public.*`, BYPASSRLS).
- **Pooler host: `aws-1-us-east-1.pooler.supabase.com` — NOT `aws-0-...`.** Supabase
  does not follow the assumed pattern; the wrong pool host fails with
  `FATAL: Tenant or user not found` (this cost us many hours). Always copy the exact
  host from the dashboard: Project Settings → Database → Connection string → Session pooler.
- Username through the pooler MUST be `upside_readonly.<project_ref>`
  (`upside_readonly.qkvegpfzstylyekmusnk`) — tenant ref appended after a dot. Bare
  `upside_readonly` fails.
- Session pooler port **5432** (transaction pooler 6543 also works for one-shot
  SELECTs). `sslmode=require`.
- The pooler is **IPv4** → works from WSL. The direct endpoint
  `db.<ref>.supabase.co` is **IPv6-only** and unreachable here (the host network
  provides no IPv6 — link-local only, no default route — so WSL mirrored mode can't
  help). Use the pooler, not the direct connection.

## Recreating `.secrets/readonly-db` if missing

```bash
mkdir -p .secrets
echo 'postgresql://upside_readonly.qkvegpfzstylyekmusnk:<PASSWORD>@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require' > .secrets/readonly-db
```

The `upside_readonly` password is hex-only (no URL-special chars). If lost, rotate it
in the Supabase SQL Editor: `alter role upside_readonly with password '<hex>';`.
