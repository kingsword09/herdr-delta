#!/bin/sh
# delta.bridge open — open or create the Delta thread bound to this herdr
# workspace, and focus it in the Delta app.
#
# Behavior:
#   - If the workspace already has a binding, open it.
#   - Else, if a pane's recent output contains a delta.dev/join/<id> link,
#     bind to that thread.
#   - Else create a fresh recorded thread bound to this workspace.
#
# Extra: if the first argv is a join URL or thread id (the link handler
# passes the clicked URL via HERDR_PLUGIN_CLICKED_URL), bind to that.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

have_delta || die "delta CLI not found on PATH; run: ln -sfn /Applications/Delta.app/Contents/MacOS/delta ~/.local/bin/delta"

# Link-handler path: clicked a https://delta.dev/jain/... URL.
clicked="${HERDR_PLUGIN_CLICKED_URL:-}"
if [ -n "$clicked" ]; then
    case "$clicked" in
    *delta.dev/join/*)
        jid="$(printf '%s' "$clicked" | sed -nE 's#.*/join/(thread_[A-Za-z0-9]+)$#\1#p')"
        [ -n "$jid" ] || die "unrecognized Delta link: $clicked"
        tid="$("$DELTA" thread create --source "$BRIDGE_SOURCE" --external-id "$(workspace_external_id)" --json 2>/dev/null | _py 'import json,sys; print(json.load(sys.stdin)["thread_id"])' || true)"
        # We can't force-bind to an arbitrary existing thread via create;
        # just open it and remember the join id.
        open_join_id "$jid"
        echo "binding to $jid is join-level; opened in Delta"
        exit 0
        ;;
    esac
fi

bf="$(binding_file)"
if [ -f "$bf" ]; then
    . "$bf"
    "$DELTA" open "$THREAD_ID" || die "could not open bound thread $THREAD_ID"
    echo "opened bound thread $THREAD_ID"
    exit 0
fi

# Scan the current pane output for a join link to adopt.
pane="$(current_pane_id || true)"
if [ -n "$pane" ]; then
    jid="$("$HERDR" pane read "$pane" --lines 200 2>/dev/null | grep -oE 'delta\.dev/join/thread_[A-Za-z0-9]+' | sed 's#.*/join/##' | tail -1 || true)"
    if [ -n "$jid" ]; then
        open_join_id "$jid"
        echo "adopted join id $jid (from pane output)"
        exit 0
    fi
fi

# Fresh recorded thread bound to this workspace.
# Fresh recorded thread bound to this workspace.
tid="$("$DELTA" thread create --source "$BRIDGE_SOURCE" --external-id "$(workspace_external_id)" --json | _py 'import json,sys; print(json.load(sys.stdin)["thread_id"])')"
[ -n "$tid" ] || die "thread create returned no id"

save_binding "$tid" >/dev/null
"$DELTA" open "$tid"
echo "created and opened Delta thread $tid"
