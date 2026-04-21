#!/bin/bash
# PreToolUse hook: blocks writes to tracked files when another active
# Claude session last modified the file (same-machine concurrency guard).
set -euo pipefail

# Source shared infrastructure (trap handlers, error capture, rotation)
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HOOK_DIR/lib/hook-preamble.sh" ]] && source "$HOOK_DIR/lib/hook-preamble.sh"

LOG="$HOME/.claude/backup.log"
# Use Windows-native path for Node.js compatibility (Git Bash $HOME = /c/Users/... which Node misreads)
REGISTRY="$HOME/.claude/.write-registry.json"

# Read tool input from stdin
STDIN_JSON=$(cat)
FILE_PATH=$(echo "$STDIN_JSON" | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{const j=JSON.parse(d);const p=j.tool_input&&j.tool_input.file_path||'';
    console.log(p.split(String.fromCharCode(92)).join('/'))}catch{console.log('')}
  })" 2>>"$LOG")

# If FILE_PATH is empty, allow (not a file write)
if [ -z "$FILE_PATH" ]; then
    exit 0
fi

# Tracked files filter — same whitelist as sync.sh
if [[ "$FILE_PATH" != *"/memory/"* ]] && \
   [[ "$FILE_PATH" != *"\\memory\\"* ]] && \
   [[ "$FILE_PATH" != *"CLAUDE.md"* ]] && \
   [[ "$FILE_PATH" != *"settings.json"* ]] && \
   [[ "$FILE_PATH" != *"mcp.json"* ]] && \
   [[ "$FILE_PATH" != *"sync.sh"* ]] && \
   [[ "$FILE_PATH" != *"session-start.sh"* ]] && \
   [[ "$FILE_PATH" != *"write-guard.sh"* ]] && \
   [[ "$FILE_PATH" != *"gws/client_secret.json"* ]] && \
   [[ "$FILE_PATH" != *"/skills/"* ]] && \
   [[ "$FILE_PATH" != *"\\skills\\"* ]] && \
   [[ "$FILE_PATH" != *"installed_plugins.json"* ]] && \
   [[ "$FILE_PATH" != *"settings.local.json"* ]] && \
   [[ "$FILE_PATH" != *"statusline.sh"* ]] && \
   [[ "$FILE_PATH" != *"usage-fetch.js"* ]] && \
   [[ "$FILE_PATH" != *"/mcp-servers/"* ]] && \
   [[ "$FILE_PATH" != *"\\mcp-servers\\"* ]] && \
   [[ "$FILE_PATH" != *"check-inbox.sh"* ]] && \
   [[ "$FILE_PATH" != *"blocklist.json"* ]] && \
   [[ "$FILE_PATH" != *"keybindings.json"* ]] && \
   [[ "$FILE_PATH" != *"/plans/"* ]] && \
   [[ "$FILE_PATH" != *"\\plans\\"* ]] && \
   [[ "$FILE_PATH" != *"/specs/"* ]] && \
   [[ "$FILE_PATH" != *"\\specs\\"* ]] && \
   [[ "$FILE_PATH" != *"history.jsonl"* ]] && \
   [[ "$FILE_PATH" != *"RESTORE.md"* ]] && \
   [[ "$FILE_PATH" != *"README.md"* ]]; then
    exit 0
fi

# No registry file yet — allow (first tracked write ever)
if [ ! -f "$REGISTRY" ]; then
    exit 0
fi

# Read registry entry for this file
# Pass REGISTRY as process.argv[1] to avoid Git Bash path mangling in Node
ENTRY=$(node -e "
const fs = require('fs');
try {
    const reg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const e = reg[process.argv[2]];
    if (e) console.log(JSON.stringify(e));
    else console.log('');
} catch(e) { console.error('write-guard: registry read failed: ' + e.message); console.log(''); }
" "$REGISTRY" "$FILE_PATH" 2>>"$LOG")

# No registry entry for this file — allow
if [ -z "$ENTRY" ]; then
    exit 0
fi

# Parse registry entry (single node call for all fields)
IFS=$'\x1f' read -r REG_PID REG_TS REG_HASH <<< "$(echo "$ENTRY" | node -e "
  const SEP='\x1f';
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    try{const j=JSON.parse(d);console.log((j.pid||'')+SEP+(j.timestamp||'')+SEP+(j.content_hash||''))}
    catch{console.log(SEP+SEP)}
  });" 2>/dev/null)" 

# Same-session check — if we're the last writer, allow
if [ "$REG_PID" = "$PPID" ]; then
    exit 0
fi

# Liveness check — if the other session is dead, allow (stale entry)
# Platform-conditional: tasklist on Windows, kill -0 on macOS/Linux
process_alive() {
    local pid="$1"
    case "$(uname -s)" in
        MINGW*|MSYS*|CYGWIN*)
            # Use exact PID filter — tasklist "PID eq" already filters, just check non-empty output
            tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -qv "INFO: No tasks" ;;
        *) kill -0 "$pid" 2>/dev/null ;;
    esac
}
if ! process_alive "$REG_PID"; then
    exit 0
fi

# Staleness check — compute current file hash vs registry hash
# Detects third-party modifications (manual edits, other tools) since the registry entry
BLOCK_REASON="another active Claude session"
if [ -f "$FILE_PATH" ]; then
    CURRENT_HASH=$( (sha256sum "$FILE_PATH" 2>/dev/null || shasum -a 256 "$FILE_PATH" 2>/dev/null) | awk '{print substr($1,1,16)}')
    if [ "$CURRENT_HASH" != "$REG_HASH" ]; then
        BLOCK_REASON="another active Claude session (file also modified externally since their last write)"
    fi
fi

# Another active session owns this file — block the write
# Format timestamp for human-readable message
# Cross-platform timestamp: macOS BSD date uses -r, GNU date uses -d
WRITE_TIME=$(date -r "$REG_TS" +"%I:%M%p" 2>/dev/null || date -d "@$REG_TS" +"%I:%M%p" 2>/dev/null || echo "")
WRITE_TIME=$(echo "$WRITE_TIME" | sed 's/^0//;s/AM/am/;s/PM/pm/')
if [ -z "$WRITE_TIME" ]; then
    WRITE_TIME="ts:$REG_TS"
fi

echo "$(date): WRITE BLOCKED: '$FILE_PATH' last modified by PID $REG_PID at $WRITE_TIME — blocking write from PID $PPID ($BLOCK_REASON)" >> "$LOG"

# Exit non-zero to block the write, with message for Claude session
echo "WRITE BLOCKED: $(basename "$FILE_PATH") was last modified by $BLOCK_REASON (PID $REG_PID) at $WRITE_TIME. Re-read the file to see the current version, then retry your edit."
exit 1
