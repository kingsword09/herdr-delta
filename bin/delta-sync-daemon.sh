#!/bin/sh
# delta.bridge startup daemon — one long-lived message bridge per herdr
# workspace that has armed one via the `sync` action.
#
# For every armed workspace we run:
#   delta thread watch <T> | python3 bridge-loop.py
#
# The python loop keeps the append sequence contiguous per stream, turns
# Delta `item` events into herdr agent prompts, and records the agent's
# replies back into the thread. It exits when the watch stream ends
# (thread deleted or daemon shutdown), which herdr logs as a normal
# startup-command completion.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

have_delta || exit 0   # nothing to bridge without the delta CLI

# React to arm markers now and keep watching for new ones.
while :; do
    for want in "$STATE_DIR"/bridge-*.want; do
        [ -e "$want" ] || continue
        ws_external="${want##*bridge-}"; ws_external="${ws_external%.want}"
        bf="$STATE_DIR/binding-$ws_external.env"
        [ -f "$bf" ] || { rm -f "$want"; continue; }
        (
            . "$bf"
            [ -n "${THREAD_ID:-}" ] || exit 0
            lock="$STATE_DIR/bridge-$ws_external.pid"
            if [ -f "$lock" ] && kill -0 "$(cat "$lock")" 2>/dev/null; then
                exit 0   # bridge already running
            fi
            "$DELTA" thread watch "$THREAD_ID" 2>/dev/null \
                | python3 lib/bridge-loop.py "$ws_external" "$THREAD_ID" &
            echo $! >"$lock"
        ) || true
        rm -f "$want"
    done
    sleep 2
done
