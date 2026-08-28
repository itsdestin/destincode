#!/bin/bash
# PostToolUse hook: reminds Claude to update the conversation topic periodically.
# Mobile-bundled version — deployed by YouCoded when YouCoded is not installed.
# Defers to YouCoded's version if both are present (Bootstrap handles this).

SESSION_ID=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

TOPIC_DIR="$HOME/.claude/topics"
mkdir -p "$TOPIC_DIR"

# Prune topic files older than 30 days (matches conversation-index.json
# retention, so a session's name survives as long as its index entry).
# Runs at most once per day.
PRUNE_MARKER="$TOPIC_DIR/.prune-marker"
NOW=$(date +%s)
DO_PRUNE=false
if [ ! -f "$PRUNE_MARKER" ]; then
    DO_PRUNE=true
else
    LAST_PRUNE=$(head -1 "$PRUNE_MARKER" 2>/dev/null)
    [[ ! "$LAST_PRUNE" =~ ^[0-9]+$ ]] && LAST_PRUNE=0
    if [ $((NOW - ${LAST_PRUNE:-0})) -ge 86400 ]; then
        DO_PRUNE=true
    fi
fi
if [ "$DO_PRUNE" = true ]; then
    find "$TOPIC_DIR" -name "topic-*" -mtime +30 -delete 2>/dev/null
    find "$TOPIC_DIR" -name "marker-*" -mtime +30 -delete 2>/dev/null
    echo "$NOW" > "$PRUNE_MARKER"
fi

MARKER="$TOPIC_DIR/marker-$SESSION_ID"
TOPIC_FILE="$TOPIC_DIR/topic-$SESSION_ID"

CURRENT_TOPIC=""
[ -f "$TOPIC_FILE" ] && CURRENT_TOPIC=$(head -1 "$TOPIC_FILE" 2>/dev/null)
if [ "$CURRENT_TOPIC" = "New Session" ] || [ -z "$CURRENT_TOPIC" ]; then
    INTERVAL=120
else
    INTERVAL=600
fi

if [ -f "$MARKER" ]; then
    LAST=$(head -1 "$MARKER")
    ELAPSED=$((NOW - LAST))
    if [ "$ELAPSED" -lt "$INTERVAL" ]; then
        exit 0
    fi
fi

echo "$NOW" > "$MARKER"

if [ ! -f "$TOPIC_FILE" ] || [ ! -s "$TOPIC_FILE" ]; then
    echo "New Session" > "$TOPIC_FILE"
fi

if [ -z "$CURRENT_TOPIC" ] || [ "$CURRENT_TOPIC" = "New Session" ]; then
    MSG="[Auto-Title] This conversation has no title yet. Run this Bash command NOW, before anything else: echo \"Topic Here\" > $TOPIC_FILE — replace Topic Here with a 3-5 word Title Case summary of this conversation. Do NOT skip this."
else
    MSG="[Auto-Title] This conversation is titled \"$CURRENT_TOPIC\". If that still describes it, do nothing at all — no tool call, no mention of this reminder. ONLY if the conversation has since moved to a genuinely different topic, run: echo \"New Title\" > $TOPIC_FILE (3-5 words, Title Case)."
fi
ESCAPED=$(echo "$MSG" | sed 's/\\/\\\\/g; s/"/\\"/g')
echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"$ESCAPED\"}}"
