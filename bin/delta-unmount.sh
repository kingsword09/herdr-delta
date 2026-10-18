#!/bin/sh
# delta.bridge unmount — release this workspace's mounts of the bound
# thread once the agents are done and their changes are uploaded.

set -eu
cd "$(dirname "$0")/.." || exit 1
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

require_binding

owner="herdr-$(workspace_external_id)"
"$DELTA" thread unmount "$THREAD_ID" --owner "$owner" || die "unmount failed"

# Refresh the workspace binding: after unmount the thread may have new
# locally owned data worth reviewing in the app.
echo "released $owner's mounts of $THREAD_ID"
echo "hint: open the thread in Delta to review and sync the agents' changes"
