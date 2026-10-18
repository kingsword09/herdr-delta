#!/bin/sh
# delta.bridge mount — keep the bound Delta thread's worktrees mounted for
# this herdr workspace, so agents in panes can work on the thread's checkout.
#
# The app mounts every worktree of the thread and follows later changes;
# checkouts are deleted when the owner process exits. We use the herdr
# server's PID as the owner so the mount lives as long as this herdr
# session does. Re-running the action restores anything removed.

set -eu
cd "$(dirname "$0")/.." || exit 1
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

require_binding

# Owner: prefer the herdr server process (mount outlives any one action),
# fall back to this script's parent. Match by exact executable name so an
# editor buffer named "herdr-server.md" can never become the owner.
owner="herdr-$(workspace_external_id)"
server_pid="$(ps -eo pid,comm | awk '$2 ~ /\/herdr$/ {print $1; exit}')"
if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    "$DELTA" thread mount "$THREAD_ID" --owner "$owner" --owner-pid "$server_pid" \
        || die "mount failed"
else
    "$DELTA" thread mount "$THREAD_ID" --owner "$owner" || die "mount failed"
fi

echo "Delta checkout mounted for owner $owner"
echo "hint: 'delta thread list-worktrees <join_id>' shows the mountable worktrees"
