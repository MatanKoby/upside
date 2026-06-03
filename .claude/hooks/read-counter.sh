#!/bin/bash
# PreToolUse hook on the Read tool: appends one TSV line per call to
# gitignored .claude-stats/file-reads.log so we can drive future content-file
# splits (M2) from data, not intuition. Non-blocking; silent; resilient to
# a missing stats dir (creates on first call). See BUILD_QUEUE.md → Batch M1.
#
# Hook protocol: JSON on stdin (Claude Code hook event), exit 0 always.
# Log format: <utc-iso>\t<file-path>\t<bytes>\t<session-id>

set -u

INPUT=$(cat)

TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
if [[ "$TOOL" != "Read" ]]; then
  exit 0
fi

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null)

if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

STATS_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude-stats"
LOG_FILE="$STATS_DIR/file-reads.log"

mkdir -p "$STATS_DIR" 2>/dev/null

# Size at hook-time. Missing file (e.g. doesn't exist yet) → 0.
BYTES=$(stat -c '%s' "$FILE_PATH" 2>/dev/null || echo "0")
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

printf '%s\t%s\t%s\t%s\n' "$TS" "$FILE_PATH" "$BYTES" "$SESSION_ID" >> "$LOG_FILE" 2>/dev/null

exit 0
