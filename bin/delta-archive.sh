#!/bin/sh
# delta.bridge archive — record the invoking pane's recent terminal output
# into the bound Delta thread as a snapshot, so the session shows up in
# `delta thread search/query` and can be reviewed alongside the code.
#
# The archive uses its own append stream (external-id archive-<pane>) so
# re-archiving the same pane continues one contiguous sequence.

set -eu
cd "$(dirname "$0")/.." || exit 1
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


# one self-contained turn: running (turn opens with turnSequence == its own
# sequence) -> agent_message(snapshot) -> idle, both pointing at the opener.
open_seq="$seq"
emit_turn() { # emit_turn <turn_seq> <json-update>
    payload="$(printf '{"schemaVersion":1,"sequence":%s,"turnSequence":%s,"update":%s}' "$seq" "$1" "$2")"
    printf '%s' "$payload" | "$DELTA" thread append "$THREAD_ID" --source "$BRIDGE_SOURCE" --external-id "$ARCH_ID" >/dev/null
    seq=$((seq+1))
    echo "$seq" >"$SEQ_FILE"
}
emit_turn "$open_seq" '{"sessionUpdate":"state_update","state":"running"}'
# content MUST be a block array; keep the snapshot one JSON string
python3 - "$SNAPSHOT" <<'PY' > /tmp/delta-arch-$$.json
import json, sys
text = sys.argv[1] if len(sys.argv) > 1 else ""
print(json.dumps({"sessionUpdate": "agent_message",
                  "messageId": f"archive-{__import__('time').strftime('%Y%m%d%H%M%S')}",
                  "content": [{"type": "text",
                                "text": f"[herdr]: pane archive\n\n{text}"}]}))
PY
emit_turn "$open_seq" "$(cat /tmp/delta-arch-$$.json)"
rm -f /tmp/delta-arch-$$.json
emit_turn "$open_seq" '{"sessionUpdate":"state_update","state":"idle"}'

echo "archived $LINES lines of pane $PANE into thread $THREAD_ID"
