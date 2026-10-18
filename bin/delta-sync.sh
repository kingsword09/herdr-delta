#!/bin/sh
# delta.bridge sync — bind the invoking pane's agent to the workspace's
# Delta thread, then hand off to the long-running bridge daemon.
#
# Direction 1 (Delta -> herdr): the daemon watches the thread; user
#   messages typed in the Delta app are submitted to the pane's agent with
#   `herdr agent prompt --wait`, and the reply is appended back to the
#   thread.
# Direction 2 (herdr -> Delta): agents in this workspace can record into
#   the same thread by piping JSONL into `delta thread append` (see
#   README); the daemon also mirrors the agent's done/idle transitions.
#
# One bridge per (workspace, pane). Re-running re-binds to the current
# focused pane.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

PANE="${HERDR_PANE_ID:-$(current_pane_id)}"
[ -n "$PANE" ] || die "no pane in context; invoke from a pane"

# Ensure a thread binding exists (create + share if needed).
bf="$(binding_file)"
if [ ! -f "$bf" ]; then
    tid="$("$DELTA" thread create --source "$BRIDGE_SOURCE" --external-id "$(workspace_external_id)" --json | _py 'import json,sys; print(json.load(sys.stdin)["thread_id"])')"
    [ -n "$tid" ] || die "thread create returned no id"
    save_binding "$tid" >/dev/null
fi
. "$bf"

# Persist which pane this workspace's bridge drives; the daemon reads it.
echo "PANE_ID=$PANE" >>"$bf" 2>/dev/null || true
# marker consumed by the daemon: start a bridge for this workspace
touch "$STATE_DIR/bridge-$(workspace_external_id).want"

# Surface the bridge in herdr's sidebar: name the pane's agent after the
# thread so `herdr agent list` reads naturally.
"$HERDR" agent rename "$PANE" delta-bridge >/dev/null 2>&1 || true

echo "bridge armed for pane $PANE <-> thread $THREAD_ID"
echo "messages sent from the Delta app will drive this pane's agent"
