#!/usr/bin/env bash
# hook-preamble.sh — Shared infrastructure for all YouCoded hooks.
# Source this as the first action in every hook script.
# Provides: trap handlers, cleanup registration, error capture,
#           portable timeout, log rotation, atomic file writes.

# ---------------------------------------------------------------------------
# Cleanup registration + trap handler
# ---------------------------------------------------------------------------
_CLEANUP_ACTIONS=()

register_cleanup() {
    _CLEANUP_ACTIONS+=("$1")
}

_run_cleanup() {
    # CRITICAL: Disable -e inside trap handler.
    # macOS ships bash 3.2 which has a bug where set -e propagates into
    # EXIT trap handlers, causing premature abort on the first non-zero
    # cleanup command. set +e ensures all cleanup actions run.
    set +e
    local _action
    for _action in "${_CLEANUP_ACTIONS[@]}"; do
        eval "$_action" 2>/dev/null
    done
}

trap _run_cleanup EXIT SIGTERM SIGINT

# ---------------------------------------------------------------------------
# Conditional error capture — replaces 2>/dev/null || true
# Logs error detail on failure instead of discarding it.
# Usage: _capture_err "description" command arg1 arg2 ...
# ---------------------------------------------------------------------------
_capture_err() {
    local cmd_name="$1"; shift
    local _tmp_err
    _tmp_err=$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/_capture_err_$$")
    register_cleanup "rm -f '$_tmp_err'"
    if "$@" 2>"$_tmp_err"; then
        rm -f "$_tmp_err"
        return 0
    else
        local _rc=$?
        local _err_summary
        _err_summary=$(head -5 "$_tmp_err" 2>/dev/null | tr '\n' ' ')
        # log_backup may not be available yet (if backup-common.sh hasn't been sourced).
        # Fall back to direct append if log_backup isn't defined.
        if declare -f log_backup &>/dev/null; then
            log_backup "WARN" "$cmd_name failed (exit $_rc): $_err_summary"
        elif [[ -n "${BACKUP_LOG:-}" ]]; then
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WARN] $cmd_name failed (exit $_rc): $_err_summary" >> "$BACKUP_LOG"
        fi
        rm -f "$_tmp_err"
        return $_rc
    fi
}

# ---------------------------------------------------------------------------
# Portable timeout wrapper — macOS lacks GNU timeout
# Usage: _with_timeout 30 command arg1 arg2 ...
# ---------------------------------------------------------------------------
_with_timeout() {
    local _secs="$1"; shift
    if command -v timeout &>/dev/null; then
        timeout "$_secs" "$@"
    else
        "$@" &
        local _pid=$!
        ( sleep "$_secs"; kill -TERM "$_pid" 2>/dev/null ) &
        local _wd=$!
        wait "$_pid" 2>/dev/null
        local _rc=$?
        kill "$_wd" 2>/dev/null
        wait "$_wd" 2>/dev/null
        return $_rc
    fi
}

# ---------------------------------------------------------------------------
# Log rotation — trims log to max_lines when it exceeds 2x threshold.
# Runs on every hook invocation; the wc -l check is <1ms.
# ---------------------------------------------------------------------------
_rotate_log() {
    local _log="$1" _max="${2:-1000}"
    if [[ -f "$_log" ]]; then
        local _lines
        _lines=$(wc -l < "$_log" 2>/dev/null || echo 0)
        if (( _lines > _max * 2 )); then
            tail -n "$_max" "$_log" > "${_log}.tmp.$$" && mv -f "${_log}.tmp.$$" "$_log"
        fi
    fi
}

# Rotate backup.log and statusline.log on every hook invocation
_rotate_log "${HOME}/.claude/backup.log" 1000
_rotate_log "${HOME}/.claude/statusline.log" 200

# ---------------------------------------------------------------------------
# Atomic file write — uses same-directory temp file for rename(2) atomicity.
# IMPORTANT: Do NOT refactor to use mktemp ($TMPDIR may be a different mount,
# breaking rename(2) atomicity). Same-directory temp is intentional.
# Usage: atomic_write "/path/to/file" "content"
# ---------------------------------------------------------------------------
atomic_write() {
    local _target="$1" _content="$2"
    local _tmp="${_target}.tmp.$$"
    echo "$_content" > "$_tmp"
    mv -f "$_tmp" "$_target"
}
