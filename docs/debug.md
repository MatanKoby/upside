# Debug endpoints

Strictly auth-gated, no FE consumer. Use from the laptop to inspect live
backend state and pull real IB Client Portal data shapes without spinning
up the local gateway.

## `GET /api/debug/ib-passthrough`

Proxies a single IB Client Portal Web API path and returns the raw response.

### Auth + safety model

- **Bearer token required** (`Authorization: Bearer <Supabase JWT>`); email must be on `UPSIDE_ALLOWED_EMAILS`. Anonymous → 401, non-whitelisted → 403.
- **IB session required** — if IBeam container isn't running or the gateway isn't authenticated, 503 `ib_not_connected`.
- **Path allowlist** (positive list of regexes in `server/src/services/ibPassthroughAllowlist.ts`). Anything not in the allowlist → 400 `path_not_allowed` with the allowed paths listed in the response.
- **GET only.** No bodies. No way to POST / PUT / DELETE through this surface.
- **Forbidden families** (rule for future allowlist additions): never add paths containing `orders`, `reply/`, `scanner/`, `place`, `cancel`, `modify`. Order operations would let a compromised whitelisted bearer execute trades; read-only is the structural mitigation.
- **Audited** — every call writes a row to `ib_api_metrics` (post-Batch-13.7: `external_api_metrics`) with endpoint tag `debug-passthrough:<path>`.

### Usage

```bash
# 1. Grab a Supabase JWT
#    Easiest: log into Upside in a browser, open DevTools → Application →
#    Local Storage → find sb-<ref>-auth-token → copy the access_token value.
TOKEN='<paste the access_token here>'

# 2. Read the current api URL from Supabase app_config (or pull from your
#    laptop browser's DevTools Network tab).
API_URL='https://<current-trycloudflare-host>'

# 3. Call passthrough
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlists" \
  | tee captures/watchlists-$(date -u +%Y-%m-%d).json

# 4. Per-watchlist detail (uses any additional query params)
curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/debug/ib-passthrough?path=/v1/api/iserver/watchlist&id=<watchlist_id>" \
  | tee captures/watchlist-<id>-$(date -u +%Y-%m-%d).json
```

`captures/` is gitignored (set up in Batch 7) — outputs land there safely.

### Currently allowed paths

(Regex source in `server/src/services/ibPassthroughAllowlist.ts` — this list is non-authoritative documentation.)

- `/v1/api/iserver/accounts`
- `/v1/api/iserver/account/<id>/summary`
- `/v1/api/iserver/auth/status`
- `/v1/api/iserver/contract/<conid>/info`
- `/v1/api/iserver/marketdata/history`
- `/v1/api/iserver/marketdata/snapshot`
- `/v1/api/iserver/secdef/search`
- `/v1/api/iserver/watchlists`
- `/v1/api/iserver/watchlist`
- `/v1/api/portfolio/accounts`
- `/v1/api/portfolio/<id>/ledger`
- `/v1/api/portfolio/<id>/positions/<page>`
- `/v1/api/portfolio/<id>/summary`
- `/v1/api/portfolio/<id>/transactions`
- `/v1/api/tickle`
