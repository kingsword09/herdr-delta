#!/bin/sh
# delta.bridge archive — record the invoking pane's recent terminal output
# into the bound Delta thread as a snapshot, so the session shows up in
# `delta thread search/query` and can be reviewed alongside the code.
#
# The archive uses its own append stream (external-id archive-<pane>) so
# re-archiving the same pane continues one contiguous sequence.

set -eu
cd "$(dirname "$0")/.."
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

require_binding

PANE="${HERDR_PANE_ID:-$(current_pane_id)}"
[ -n "$PANE" ] || die "no pane in context; invoke from a pane"

LINES="${DELTA_ARCHIVE_LINES:-200}"
SNAPSHOT="$("$HERDR" pane read "$PANE" --lines "$LINES" 2>/dev/null)" || SNAPSHOT=""
[ -n "$SNAPSHOT" ] || die "no output to archive from pane $PANE"

ARCH_ID="archive-$PANE"
SEQ_FILE="$STATE_DIR/seq-$(workspace_external_id)-$ARCH_ID.txt"
seq=1
[ -f "$SEQ_FILE" ] && seq=$(cat "$SEQ_FILE")

emit() { # emit <json-update> -> one append record with our sequence bookkeeping
    payload="$(printf '{"schemaVersion":1,"sequence":%s,"turnSequence":%s,"update":%s}' "$seq" "$seq" "$1")"
    printf '%s' "$payload" | "$DELTA" thread append "$THREAD_ID" --source "$BRIDGE_SOURCE" --external-id "$ARCH_ID" >/dev/null
    seq=$((seq+1))
    echo "$seq" >"$SEQ_FILE"
}

# one self-contained turn: running -> agent_message(snapshot) -> idle
emit '{"sessionUpdate":"state_update","state":"running"}'
# content MUST be a block array; keep the snapshot one JSON string
python3 - "$SNAPSHOT" <<'PY' > /tmp/delta-arch-$$.json
import json, sys
text = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps({"sessionUpdate": "agent_message",
                  "messageId": f"archive-{__import__('time').strftime('%Y%m%d%H%M%S')}",
                  "content": [{"type": "text",
                                "text": f"[herdr]: pane archive\n\n{text}"}]}))
PY
emit "$(cat /tmp/delta-arch-$$.json)"
rm -f /tmp/delta-arch-$$.json
emit '{"sessionUpdate":"state_update","state":"idle"}'

echo "archived $LINES lines of pane $PANE into thread $THREAD_ID"
