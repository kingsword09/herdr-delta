#!/bin/sh
# delta.bridge mount — keep the bound Delta thread's worktrees mounted for
# this herdr workspace, so agents in panes can work on the thread's checkout.
#
# The app mounts every worktree of the thread and follows later changes;
# checkouts are deleted when the owner process exits. We use the herdr
# server's PID as the owner so the mount lives as long as this herdr
# session does. Re-running the action restores anything removed.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

require_binding

# Owner: prefer the herdr server process (mount outlives any one action),
# fall back to this script's parent.
owner="herdr-$(workspace_external_id)"
if server_pid="$(pgrep -f 'herdr.*server' | head -1)" && [ -n "$server_pid" ]; then
    "$DELTA" thread mount "$THREAD_ID" --owner "$owner" --owner-pid "$server_pid" || die "mount failed"
else
    "$DELTA" thread mount "$THREAD_ID" --owner "$owner" || die "mount failed"
fi

# Record where the checkouts landed so agents can cd into them and the
# unmount action knows what to print.
mount_root="$STATE_DIR/mount-$(workspace_external_id).txt"
echo "$("$DELTA" thread list-worktrees "$("$DELTA" thread status "$THREAD_ID" --json | _py 'import json,sys; print(json.load(sys.stdin)["id"])' 2>/dev/null || echo "$THREAD_ID")" 2>/dev/null || true)" >"$mount_root" || true

"$DELTA" thread status "$THREAD_ID" >/dev/null 2>&1 || true
echo "Delta checkout mounted for owner $owner"
echo "hint: 'delta thread list-worktrees <join_id>' shows the mountable worktrees"
