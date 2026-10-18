#!/bin/sh
# delta.bridge startup daemon — message bridges plus open dispatch rounds.
#
# Two kinds of watches, one per thread:
#   1. workspace bridges armed by the `sync` action (binding-*.env)
#   2. open engine=delta dispatch rounds (round-*.env with ENGINE=delta);
#      dispatch removes the round file when its round ends, which also ends
#      this watch
#
# The loop exits on TERM/INT and tears down the watch pipelines it started.

set -u
cd "$(dirname "$0")/.." || exit 1
. lib/common.sh

have_delta || exit 0   # nothing to bridge without the delta CLI

cleanup() {
    # Kill whole pipeline groups (watch | python), not just the shells.
    for pf in "$STATE_DIR"/bridge-*.pid; do
        [ -e "$pf" ] || continue
        pgid="$(cat "$pf" 2>/dev/null)"
        [ -n "$pgid" ] && kill -TERM -"$pgid" 2>/dev/null
        rm -f "$pf"
    done
    exit 0
}
trap cleanup TERM INT

start_watch() { # start_watch <label> <thread_id> [extra env...]
    label="$1"; tid="$2"; shift 2
    lock="$STATE_DIR/bridge-$label.pid"
    if [ -f "$lock" ]; then
        old="$(cat "$lock" 2>/dev/null)"
        # Stale check: same pgid AND its process group leader is alive.
        if [ -n "$old" ] && kill -0 -"$old" 2>/dev/null; then
            return 0
        fi
        rm -f "$lock"
    fi
    (
        trap 'exit 0' TERM INT
        exec "$DELTA" thread watch "$tid" 2>/dev/null \
            | exec python3 lib/bridge-loop.py "$label" "$tid"
    ) &
    echo $! >"$lock"
}

while :; do
    # 1. workspace bridges
    for bf in "$STATE_DIR"/binding-*.env; do
        [ -e "$bf" ] || continue
        label="${bf##*binding-}"; label="${label%.env}"
        (
            . "$bf"
            [ -n "${THREAD_ID:-}" ] || exit 0
            start_watch "$label" "$THREAD_ID"
        ) || true
    done

    # 2. open engine=delta rounds
    for rf in "$STATE_DIR"/round-*.env; do
        [ -e "$rf" ] || continue
        label="${rf##*round-}"; label="${label%.env}"
        (
            . "$rf"
            [ "${ENGINE:-}" = "delta" ] || exit 0
            [ -n "${THREAD_ID:-}" ] || exit 0
            start_watch "round-$label" "$THREAD_ID"
        ) || true
    done

    sleep 2
done
