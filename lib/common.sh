#!/bin/sh
# delta.bridge — shared helpers. Sourced by every action script.
# Contract notes (verified against Delta 0.20.1 / herdr 0.9.3):
#   - `delta` must be a symlink to the app binary, never a copy (copies get SIGKILLed).
#   - thread append requires the thread to be shared with the organization first.
#   - append `sequence` must be contiguous per (source, external-id) stream,
#     starting at 1; the recorded-stream state lives in Delta's sqlite.

DELTA="${DELTA_BIN:-delta}"
HERDR="${HERDR_BIN_PATH:-herdr}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-$HOME/.local/state/herdr-delta}"
BRIDGE_SOURCE="herdr"
JOIN_URL_RE='https://delta\.dev/join/(thread_[A-Za-z0-9]+)'

mkdir -p "$STATE_DIR"

die() {
    echo "delta.bridge: $*" >&2
    exit 1
}

# Require the delta CLI on PATH (user may not have linked it yet).
have_delta() {
    command -v "$DELTA" >/dev/null 2>&1
}

# Map the current herdr workspace to a stable external-id so
# `thread create` reuses the same Delta thread across invocations.
workspace_external_id() {
    ws="${HERDR_WORKSPACE_ID:?no herdr workspace context}"
    echo "herdr-$ws"
}

# State file for one bridge binding: <state>/binding-<external-id>.env
binding_file() {
    echo "$STATE_DIR/binding-$(workspace_external_id).env"
}

# Load a binding (THREAD_ID + friends) or fail with a friendly message.
require_binding() {
    bf="$(binding_file)"
    [ -f "$bf" ] || die "no Delta thread bound to this workspace yet; run the 'open' or 'sync' action first"
    . "$bf"
    [ -n "$THREAD_ID" ] || die "binding file $bf has no THREAD_ID"
}

# Ensure a thread is shared (append refuses unshared threads) and store the binding.
save_binding() {
    tid="$1"
    share_out="$("$DELTA" thread share "$tid" --visibility organization 2>&1)" || true
    {
        echo "THREAD_ID=$tid"
        echo "LAST_SHARED_AT=$(date -u +%FT%TZ)"
    } >"$(binding_file)"
    echo "$tid"
}

# Extract a thread id from a Delta join URL (delta.dev/join/thread_xxx)
# and open it. Used by the open action and the link handler.
open_join_id() {
    jid="$1"
    # `delta open` accepts the join id directly.
    "$DELTA" open "$jid" || die "could not open $jid in Delta"
}

# Resolve which pane to operate on: explicit HERDR_PANE_ID, else the
# focused pane of the invoking context.
current_pane_id() {
    if [ -n "${HERDR_PANE_ID:-}" ]; then
        echo "$HERDR_PANE_ID"
        return
    fi
    "$HERDR" pane list 2>/dev/null | _py 'import json,sys
d=json.load(sys.stdin)
for p in d["result"]["panes"]:
    if p.get("focused"):
        print(p["pane_id"]); break
'
}

_py() {
    python3 -c "$1"
}

# Default dispatch engine, overridable per user via the plugin config dir.
default_engine() {
    cfg="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/herdr/plugins/config/delta.bridge}/engine"
    if [ -f "$cfg" ]; then cat "$cfg"; else echo terminal; fi
}

# Run a headless terminal agent inside <checkout>, logging to the round log.
# Executor templates live here; add one agent = add one case.
run_terminal_agent() { # run_terminal_agent <task> <checkout> <log-file>
    task="$1"; ck="$2"; log="${3:-/dev/null}"
    model_args=""
    [ -n "${MODEL:-}" ] && model_args="$model_args -m $MODEL"
    effort_args=""
    [ -n "${EFFORT:-}" ] && effort_args="$effort_args -c model_reasoning_effort=$EFFORT"
    case "${AGENT:-codex}" in
    codex)
        (cd "$ck" && codex exec $model_args $effort_args --skip-git-repo-check \
            --dangerously-bypass-approvals-and-sandbox "$task") >"$log" 2>&1
        ;;
    claude)
        (cd "$ck" && claude -p $model_args --dangerously-skip-permissions "$task") >"$log" 2>&1
        ;;
    zcode)
        # npx-installed ZCode: headless via --prompt; yolo mode so it lands
        # changes. Long form required: -p is ambiguous in 0.16.9.
        zcode_bin="${ZCODE_BIN:-zcode}"
        command -v "$zcode_bin" >/dev/null 2>&1 \
            || zcode_bin="${HOME}/.npm/_npx/e13d1ea324ce7e27/node_modules/.bin/zcode"
        (cd "$ck" && "$zcode_bin" --prompt "$task" --mode yolo --surface terminal) >"$log" 2>&1
        ;;
    *)
        echo "delta.bridge: no headless template for agent '${AGENT:-}'" >"$log"
        return 1
        ;;
    esac
}
