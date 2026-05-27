---
name: read-discord
description: Read messages from the Upside Discord server via the provisioned bot — the #errors / #errors-critical channels (API failures with their response bodies), #profit-zone (zone alerts), #general. Use to debug an error seen in the channel ("why did X at time T happen?"), triage what's erroring, or check what alerts fired. The bot token is in .upside-discord-token. Read-only (GET only); safe to run freely.
---

# Read the Upside Discord (bot, read-only)

Discord is the error-observability surface, and it carries **more than
`external_api_metrics`** — the actual upstream response body (e.g. IB's
`"no bridge"`), params, and `notifyError` criticals. Read it *first* when
debugging an error; use the DB (`query-supabase`) only to build a timeline
around it. (Earlier mistake: don't reconstruct from the DB and assume the
channel is uninformative — read the channel.)

The bot token lives in the gitignored repo-root file `.upside-discord-token`
(raw bot token, like `.upside-readonly-db`). **Never print it** — pass it via
command substitution so it never lands in the command text or output:

```bash
TOKEN=$(cat .upside-discord-token | tr -d '\r\n')
```

Only GET is used here — reading, never posting (the app posts via webhooks).

## Channels (Upside guild `1505264574037753896`)

| channel | id | what's in it |
|---|---|---|
| `#errors` | `1505264738890813461` | routine API failures (`notifyApiFailure`) + `ib.gateway_unreachable` criticals |
| `#errors-critical` | `1505265517362151424` | structural breakage (process/loop crash, Supabase ping) |
| `#profit-zone` | `1508799334974492813` | zone-entry alerts (`notifyProfitZoneEntry`) |
| `#general` | `1505264574579085355` | — |

IDs can change if a channel is recreated — rediscover with:

```bash
curl -s -H "Authorization: Bot $TOKEN" "https://discord.com/api/v10/users/@me/guilds" | jq -r '.[] | "\(.id)\t\(.name)"'
curl -s -H "Authorization: Bot $TOKEN" "https://discord.com/api/v10/guilds/<GUILD_ID>/channels" | jq -r '.[] | select(.type==0) | "\(.id)\t#\(.name)"'
```

## Read recent messages

**Gotcha:** the notifier puts everything in an **embed**, not `.content`
(`.content` is empty). The title is `🔴 <key>`, the description is `HTTP <status>`,
and the real detail (Status / Params / **Response** body) is in `embeds[0].fields`.
This extraction handles both embed and plain-content messages:

```bash
curl -s -H "Authorization: Bot $TOKEN" \
  "https://discord.com/api/v10/channels/1505264738890813461/messages?limit=15" \
| jq -r '.[] | "── \(.timestamp) ──\n\(.embeds[0].title // .content // "")\n\(.embeds[0].description // "")\nFIELDS: \(.embeds[0].fields // [] | map("\(.name)=\(.value)") | join(" | "))"'
```

- `?limit=N` (max 100). `?before=<message_id>` / `?after=<message_id>` to page
  to an older/newer window.
- Times in the embeds/`.timestamp` are **UTC**; the user reports local (UTC+3),
  so user-local − 3h = UTC.

## Interpreting IB error bodies (the value Discord adds)

| Response body | meaning |
|---|---|
| `Bad Request: no bridge` (400) | no authenticated brokerage-session bridge — IB session dropped (overnight reset / logout). |
| `Service Unavailable` (503) on `portfolio/.../positions` | portfolio subsystem not ready — session warming or mid-drop. |
| `ib.gateway_unreachable` (critical) | the gateway container itself is down/unreachable (status-0 throws). |

To debug a specific error: read the channel for the message + body (above), then
correlate with a ±10-min `external_api_metrics` timeline via `query-supabase`
(healthy-before + recovered-after = transient blip, not a bug).
