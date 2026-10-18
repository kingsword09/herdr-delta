#!/bin/sh
# delta.bridge dispatch — orchestrate one full task round through Delta's
# execution substrate, with a pluggable engine.
#
# Usage (invoked as a plugin action; argv after the action id is the task):
#   delta.bridge.dispatch <TASK> [options]
#
# Options:
#   --engine delta|terminal   delta: record the plan, human presses Send in
#                             the GUI, Delta's own agent executes.
#                             terminal: run a headless agent inside the
#                             mounted checkout (default).
#   --agent NAME              terminal engine executor: codex|claude (default codex)
#   --model M                 passed to the terminal agent
#   --effort E                reasoning effort for the terminal agent
#   --merge direct|pr-squash  remembered for finalize (default direct)
#   --reviewer PANE_ID        pane whose agent reviews when the round ends
#   --cwd DIR                 project directory to attach (default: workspace
#                             project, i.e. first pane cwd)
#
# Round shape (both engines share steps 1-3 and 5-6):
#   1. create/reuse thread bound to this workspace, attach the project
#   2. mount an isolated checkout for this dispatch (owner-pid = this script:
#      it is returned automatically when the round ends)
#   3. record the task into the thread
#   4. execute:
#        delta    -> open the GUI focused on the thread; the human sends the
#                    recorded plan; the daemon watches for turn completion
#        terminal -> run the headless agent in the checkout, wait, record
#                    its final transcript into the thread
#   5. unmount: changes upload into the thread history and land in the
#      project working tree as uncommitted changes
#   6. nudge the reviewer pane to start review
#
# Output: the thread id and checkout directory; the reviewer message is left
# to the daemon (delta engine) or sent here (terminal engine).

set -eu
cd "$(dirname "$0")/.." || exit 1
. lib/common.sh

have_delta || die "delta CLI not found on PATH"

TASK=""
ENGINE=""
AGENT="codex"
MODEL=""
EFFORT=""
MERGE=""
REVIEWER=""
PROJECT_DIR="${DELTA_PROJECT:-}"
while [ $# -gt 0 ]; do
    case "$1" in
    --engine)   ENGINE="$2"; shift 2 ;;
    --agent)    AGENT="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --effort)   EFFORT="$2"; shift 2 ;;
    --merge)    MERGE="$2"; shift 2 ;;
    --reviewer) REVIEWER="$2"; shift 2 ;;
    --cwd)      PROJECT_DIR="$2"; shift 2 ;;
    -*)         die "unknown option: $1" ;;
    *)          TASK="${TASK}${TASK:+ }$1"; shift ;;
    esac
done
[ -n "$TASK" ] || die "no task given: dispatch \"<task text>\""
ENGINE="${ENGINE:-$(default_engine)}"

# Resolve the project directory the same way `open` does.
if [ -z "$PROJECT_DIR" ] && [ -n "${HERDR_WORKSPACE_ID:-}" ]; then
    PROJECT_DIR="$("$HERDR" pane list 2>/dev/null | _py 'import json,sys,os
ws = os.environ.get("HERDR_WORKSPACE_ID")
for p in json.load(sys.stdin)["result"]["panes"]:
    if p.get("workspace_id") == ws:
        print(p.get("cwd") or p.get("foreground_cwd") or "")
        break' || true)"
fi
[ -n "$PROJECT_DIR" ] || die "no project directory; pass --cwd or run inside a project workspace"
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$PROJECT_DIR is not a Git checkout"

# 1. thread for this task, bound to the workspace, with the project attached.
ext="$(workspace_external_id)-task-$(date +%s)-$$"
tid="$("$DELTA" thread create --source "$BRIDGE_SOURCE" --external-id "$ext" --json | _py 'import json,sys; print(json.load(sys.stdin)["thread_id"])')"
[ -n "$tid" ] || die "thread create failed"
# append refuses unshared threads (server-confirmed receipts).
"$DELTA" thread share "$tid" --visibility organization >/dev/null 2>&1 || true
"$DELTA" worktree attach "$PROJECT_DIR" --thread "$tid" --json >/dev/null 2>&1 || true

# 2. borrow an isolated checkout; its lifetime equals this dispatch. The
#    trap guarantees the checkout is returned even when a later step dies.
owner="dispatch-$ext"
mounted=""
return_checkout() {
    [ -n "$mounted" ] || return 0
    "$DELTA" thread unmount "$tid" --owner "$owner" --json >/dev/null 2>&1 || true
    mounted=""
}
trap return_checkout EXIT INT TERM
mount_json="$("$DELTA" thread mount "$tid" --owner "$owner" --owner-pid $$ --json)" || die "thread mount failed"
mounted=1
checkout="$(printf '%s' "$mount_json" | _py 'import json,sys; print(json.load(sys.stdin)["directory"])')"
[ -n "$checkout" ] && [ -d "$checkout" ] || die "mount returned no checkout directory"

# 3. record the task (and dispatch metadata) as the opening of the round.
SEQ_FILE="$STATE_DIR/seq-$ext.txt"
seq=1
record() { # record <turn_seq> <json-update>
    printf '{"schemaVersion":1,"sequence":%s,"turnSequence":%s,"update":%s}' \
        "$seq" "$1" "$2" \
        | "$DELTA" thread append "$tid" --source "$BRIDGE_SOURCE" --external-id "$ext" >/dev/null
    seq=$((seq+1)); echo "$seq" >"$SEQ_FILE"
}
open_seq=1
task_json="$(printf '%s' "$TASK" | _py 'import json,sys
print(json.dumps({"sessionUpdate": "user_message",
                  "messageId": "task",
                  "content": [{"type": "text",
                               "text": "[delta-bridge]: " + sys.stdin.read().strip()}]}))')"
record "$open_seq" '{"sessionUpdate":"state_update","state":"running"}'
record "$open_seq" "$task_json"

echo "thread:   $tid"
echo "checkout: $checkout"
echo "engine:   $ENGINE (merge: ${MERGE:-direct})"

# 4. execute
if [ "$ENGINE" = "delta" ]; then
    # Human-in-the-loop execution: focus the app on the thread; the daemon
    # watches this round's task thread and nudges the reviewer when the GUI
    # turn goes back to idle. The round file stays until finalize runs.
    "$DELTA" open "$tid" || true
    {
        echo "THREAD_ID=$tid"
        echo "ENGINE=delta"
        echo "MERGE=${MERGE:-direct}"
        echo "REVIEWER=${REVIEWER:-}"
        echo "CHECKOUT=$checkout"
        echo "PROJECT_DIR=$PROJECT_DIR"
    } >"$STATE_DIR/round-$ext.env"
    echo "recorded the task; press Send in Delta to execute, the reviewer will be nudged when the turn completes"
    exit 0   # trap returns the checkout; the GUI round continues asynchronously
else
    # Headless execution inside the mounted checkout.
    run_terminal_agent "$TASK" "$checkout" "$STATE_DIR/exec-$ext.log" || true
    agent_out="$(tail -c 20000 "$STATE_DIR/exec-$ext.log" 2>/dev/null || true)"
    out_json="$(printf '%s' "$agent_out" | _py 'import json,sys
print(json.dumps({"sessionUpdate": "agent_message",
                  "messageId": "exec",
                  "content": [{"type": "text",
                               "text": "[herdr]: terminal agent output\n\n" + sys.stdin.read()[-8000:]}]}))')"
    record "$open_seq" "$out_json"
    # Close the turn: Delta shows the round as running until this lands.
    record "$open_seq" '{"sessionUpdate":"state_update","state":"idle"}'
fi

# 5. return the checkout; changes upload into thread history and appear in
#    the project working tree as uncommitted changes.
"$DELTA" thread unmount "$tid" --owner "$owner" --json >/dev/null || true

if [ "$ENGINE" = "terminal" ] && [ -n "$REVIEWER" ]; then
    # 6a. terminal rounds end here; nudge the reviewer immediately.
    review_msg="Delta round finished (thread $tid). Review uncommitted changes in $PROJECT_DIR (git diff) or open the thread in Delta; run delta.bridge.finalize --mode ${MERGE:-direct} when satisfied."
    "$HERDR" agent prompt "$REVIEWER" "$review_msg" >/dev/null 2>&1 \
        || "$HERDR" pane send-text "$REVIEWER" "$review_msg" >/dev/null 2>&1 \
        || true
fi
# 6b. delta-engine rounds: the daemon nudges the reviewer when the GUI turn
# completes (the round file stays until then).
{ echo "THREAD_ID=$tid"; echo "MERGE=${MERGE:-direct}"; echo "PROJECT_DIR=$PROJECT_DIR"; } \
    >"$STATE_DIR/finalize-$(workspace_external_id).env"

echo "dispatch round complete; uncommitted changes are in $PROJECT_DIR"
