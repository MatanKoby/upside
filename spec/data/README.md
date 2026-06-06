# `spec/data/` — Data-flow catalog

The map between external sources, the DB tables, and every consumer. Use it to
keep a **single source of truth per data type**, avoid redundant pipelines, and
right-size the schema. This folder is the data-flow layer; `../schema.md` is the
table definitions.

## Files

- **`sources.md`** — the producer catalog: every external source (IB / Finnhub / Polygon / Yahoo + planned RSS/SEC), the requests we make, the fields we use, and where each lands. Includes the S0.5 universe-coverage decision and the reliability/fallback posture (incl. the daily-bars gap → planned `daily_bars` layer).
- **`consumers.md`** — every consumer (crons, engines, API routes, client hooks/pages): what it reads, what it writes, which source it hits.

Both files end with an **Observations** section flagging SSOT violations,
unused sources, double-pulls, and pipeline-consolidation opportunities surfaced
by the 2026-06-06 audit.

## Cross-references

- Table definitions: `../schema.md`
- End-to-end flows: `../flows.md`
- Job queue (decouples producers from rate-limited upstreams): `../job-queue.md`
