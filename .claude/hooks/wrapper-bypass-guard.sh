#!/bin/bash
# Pre-tool-use hook: block raw `psql` and raw `curl https://discord.com/api/...`
# in Bash invocations from Claude Code, forcing the use of bin/upside-psql /
# bin/upside-discord instead. Rationale: the wrappers read secrets from
# gitignored .secrets/ files via stdin-of-the-tool — never letting the
# password/token land on the command line (where it would otherwise leak to
# the transcript log). See feedback_use_wrappers_not_raw memory.
#
# Hook protocol: JSON on stdin (Claude Code hook event), exit 2 to block.

set -u

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
if [[ "$TOOL" != "Bash" ]]; then
  exit 0
fi

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

# Word-boundary regex matching raw `psql ` (at command start, or after
# any of ; & | ` ( whitespace). Note the trailing required space.
PSQL_RAW='(^|[[:space:];&|`(])psql[[:space:]]'
PSQL_WRAPPED='(^|[[:space:];&|`(])\.?/?bin/upside-psql([[:space:]]|$)'

if echo "$CMD" | grep -Eq "$PSQL_RAW"; then
  if ! echo "$CMD" | grep -Eq "$PSQL_WRAPPED"; then
    cat >&2 <<'EOF'
BLOCKED by .claude/hooks/wrapper-bypass-guard.sh

Raw `psql` is not allowed in this project — use `bin/upside-psql` instead.

  bin/upside-psql -tAc "select count(*) from quotes;"
  bin/upside-psql -f path/to/query.sql
  bin/upside-psql <<'SQL'
    select symbol from positions limit 5;
  SQL

The wrapper reads the connection string from .secrets/readonly-db so the
password never lands on the command line (which would leak it into the
transcript log — see the 2026-05-30 rotation incident).

If the wrapper is missing a feature you need, extend bin/upside-psql rather
than bypass it. See feedback_use_wrappers_not_raw memory.
EOF
    exit 2
  fi
fi

# Discord API direct hits (curl, wget, http, etc. against discord.com/api/).
DISCORD_RAW='discord\.com/api/'
DISCORD_WRAPPED='(^|[[:space:];&|`(])\.?/?bin/upside-discord([[:space:]]|$)'

if echo "$CMD" | grep -Eq "$DISCORD_RAW"; then
  if ! echo "$CMD" | grep -Eq "$DISCORD_WRAPPED"; then
    cat >&2 <<'EOF'
BLOCKED by .claude/hooks/wrapper-bypass-guard.sh

Raw calls against the Discord API are not allowed — use `bin/upside-discord`.

  bin/upside-discord channels
  bin/upside-discord errors 20
  bin/upside-discord dip-buys 50 --raw | jq .

The wrapper reads the bot token from .secrets/discord-token so it never
lands on the command line.

If the wrapper is missing a feature you need, extend bin/upside-discord
rather than bypass it. See feedback_use_wrappers_not_raw memory.
EOF
    exit 2
  fi
fi

exit 0
