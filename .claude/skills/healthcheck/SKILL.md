---
name: healthcheck
description: Check whether the deployed Upside backend is alive and in what state — api reachable, IB connected/disconnected/stopped, Supabase + Redis reachable, price pollers fresh, recent API failures. Read-only and side-effect-free (an unauthenticated GET /healthz plus read-only DB reads), so safe to run freely without asking. Use when diagnosing 5xx/524/CORS errors, "is IB connected?", stale prices, or after a VPS rebuild.
---

# Health-check the Upside backend (read-only)

Two layers, both safe to run freely — no writes, no side effects, so no need to
ask first (same standing as the `query-supabase` skill).

## 1. Live component check — `GET /healthz`

The api exposes an **unauthenticated** health endpoint that aggregates every
subsystem server-side, each sub-check bounded to ~1s, so it returns within ~3s
**even when IB is down** (unlike `/history`, which hangs ~5s+ and 524s). The api
is only reachable through the rotating Cloudflare Quick Tunnel, whose URL lives
in `app_config.api_url` — so discover it first, then curl:

```bash
API_URL=$(psql "$(cat .secrets/readonly-db)" -tAc "select value from app_config where key='api_url';")
curl -s --max-time 10 "$API_URL/healthz" | jq .
```

Response shape:

```json
{ "ok": true, "env": "production",
  "ib": "connected" | "disconnected" | "stopped" | "unknown",
  "supabase": "reachable" | "unreachable",
  "redis": "reachable" | "unreachable",
  "lastPricePoll": "2026-05-27T05:52:00Z" | null }
```

Interpreting it:

- `ok` is false **only** if Supabase or Redis is unreachable (hard
  prerequisites). `ib: "stopped"` is normal — IB runs on-demand (Batch 13), so a
  stopped container does **not** make the api unhealthy.
- `ib: "connected"` → IB authenticated; marketdata endpoints (snapshot / history
  / sparkline) work. `disconnected` / `stopped` → those endpoints fail or hang;
  prices come from the Finnhub fallback.
- `lastPricePoll` null or stale (≫ a few minutes during a session) → the IB price
  poller isn't cycling.
- curl itself fails / times out → the tunnel or api is down. Fall back to layer 2.

## 2. DB-only signals (work even if the api/tunnel is unreachable)

No live request — pure read-only Postgres (connection notes: see the
`query-supabase` skill). `price_source` is the **no-live-call way to answer "is
IB connected?"**: a fresh `finnhub` write means IB is down (the Finnhub poller
only takes over then); `ib` means it's connected.

```bash
# Pollers alive + which source is winning.
psql "$(cat .secrets/readonly-db)" -P pager=off -c \
  "select symbol, price_source, last_price_update_at, now() - last_price_update_at as age \
   from positions order by last_price_update_at desc nulls last limit 5;"

# Recent external-API failures (IB / Finnhub), last 30 min. A burst of status-0
# rows on iserver/marketdata/* is IB-down's signature (calls throw / time out).
psql "$(cat .secrets/readonly-db)" -P pager=off -c \
  "select captured_at, provider, endpoint, status from external_api_metrics \
   where succeeded = false and captured_at > now() - interval '30 minutes' \
   order by captured_at desc limit 20;"
```

> Note: `external_api_metrics` has no error-detail column — `status 0` means the
> call threw, but not *why*. (Known observability gap; see CLAIMS / the Discord
> suppression policy.)
