#!/usr/bin/env python3
"""delta.bridge bridge-loop — one bridge between one herdr workspace and one Delta thread.

Reads `delta thread watch` JSONL on stdin. For each user item written in the
Delta app, submits it to the bound pane's agent via `herdr agent prompt
--wait`, then appends the agent's reply (and turn state transitions) back
into the thread via `delta thread append`.

Delta append contract (probed against 0.20.1):
  envelope: {"schemaVersion":1,"sequence":N,"turnSequence":M,"update":{...}}
  - sequence must be contiguous per (source, external-id) stream, from 1
  - a turn opens with update={"sessionUpdate":"state_update","state":"running"}
    and turnSequence == that record's sequence
  - messages: {"sessionUpdate":"user_message"|"agent_message","messageId":..,
    "content":[{"type":"text","text":...}]}   # content MUST be a block array
  - the turn closes with {"sessionUpdate":"state_update","state":"idle"}
  - text prefix "[name]: " becomes the visible sender name in Delta
"""
import json
import os
import re
import subprocess
import sys
import time

WS_EXTERNAL = sys.argv[1] if len(sys.argv) > 1 else "herdr-default"
THREAD_ID = sys.argv[2] if len(sys.argv) > 2 else None
STATE_DIR = os.environ.get("HERDR_PLUGIN_STATE_DIR",
                            os.path.expanduser("~/.local/state/herdr-delta"))
BINDING = os.path.join(STATE_DIR, f"binding-{WS_EXTERNAL}.env")
DELTA = os.environ.get("DELTA_BIN", "delta")
HERDR = os.environ.get("HERDR_BIN_PATH", "herdr")
BRIDGE_SOURCE = "herdr"
SEQ_FILE = os.path.join(STATE_DIR, f"seq-{WS_EXTERNAL}-{THREAD_ID}.txt" if THREAD_ID else f"seq-{WS_EXTERNAL}.txt")
SEEN_FILE = os.path.join(STATE_DIR, f"seen-{WS_EXTERNAL}-{THREAD_ID}.txt" if THREAD_ID else f"seen-{WS_EXTERNAL}.txt")
EXTRA_ID = "bridge"          # external-id of this bridge's append stream
WATCH_USER = "delta-bridge"   # sender prefix we recognize from the app


def binding(key, default=None):
    try:
        with open(BINDING) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.rstrip("\n").split("=", 1)[1]
    except OSError:
        pass
    return default


def pane_id():
    # Re-read each time: the user may re-run `sync` to retarget the bridge.
    return binding("PANE_ID")


def herdr(*args, timeout_s=300):
    """Run a herdr CLI command, return (rc, stdout). Never raises."""
    try:
        p = subprocess.run([HERDR, *args], capture_output=True, text=True,
                            timeout=timeout_s)
        return p.returncode, p.stdout
    except Exception as e:
        return 1, str(e)


def next_seq():
    try:
        with open(SEQ_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return 1


def bump_seq(n):
    with open(SEQ_FILE, "w") as f:
        f.write(str(n + 1))


def append_record(update, turn_seq):
    """Append one ACP record; keeps the per-stream sequence contiguous."""
    seq = next_seq()
    rec = {"schemaVersion": 1, "sequence": seq,
           "turnSequence": turn_seq if turn_seq is not None else seq,
           "update": update}
    payload = json.dumps(rec, ensure_ascii=False)
    p = subprocess.run([DELTA, "thread", "append", THREAD_ID,
                        "--source", BRIDGE_SOURCE,
                        "--external-id", EXTRA_ID],
                       input=payload, capture_output=True, text=True, timeout=60)
    if p.returncode == 0:
        bump_seq(seq)
        return True
    # A rejected record still consumed nothing; retry next time.
    sys.stderr.write(f"append failed (seq {seq}): {p.stderr.strip()}\n")
    return False


def seen(item_id):
    try:
        with open(SEEN_FILE) as f:
            return item_id in f.read().split()
    except OSError:
        return False


def mark_seen(item_id):
    with open(SEEN_FILE, "a") as f:
        f.write(item_id + "\n")


def agent_reply_text():
    """Snapshot the pane's recent output; used as the reply after a turn."""
    rc, out = herdr("pane", "read", pane_id(), "--lines", "80", timeout_s=15)
    return out if rc == 0 else ""


def main():
    if not THREAD_ID:
        sys.stderr.write("bridge-loop: no thread id\n")
        return
    turn_open_seq = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = ev.get("type")

        if kind != "item":
            # turn/presence/worktrees/children events are informational
            continue
        item = ev.get("item") or {}
        iid = item.get("id")
        if not iid or seen(iid):
            continue
        mark_seen(iid)

        ikind = item.get("kind")
        text = ((item.get("content") or {}).get("text") or "").strip()
        if not text:
            continue

        if ikind == "user_message":
            # Only relay messages authored from the Delta app that are
            # addressed to the bridge, so humans and agents can coexist.
            if not text.startswith(f"[{WATCH_USER}]"):
                continue
            prompt = re.sub(rf"^\[{re.escape(WATCH_USER)}\]:?\s*", "", text)
            pane = pane_id()
            if not pane:
                continue
            # Open a recorded turn, submit, close with the agent's tail.
            if not append_record({"sessionUpdate": "state_update",
                                  "state": "running"}, None):
                continue
            turn_open_seq = next_seq() - 1
            rc, out = herdr("agent", "prompt", pane, prompt,
                            "--wait", "--until", "idle", "done",
                            timeout_s=1200_000 // 1000)
            reply = agent_reply_text()
            append_record({"sessionUpdate": "agent_message",
                           "messageId": f"r-{int(time.time())}",
                           "content": [{"type": "text",
                                        "text": f"[herdr]: {reply.strip()}"}]},
                          turn_open_seq)
            append_record({"sessionUpdate": "state_update",
                           "state": "idle"}, turn_open_seq)
        elif ikind == "agent_message":
            # Replies the bridge itself appended arrive here; they are
            # already recorded, nothing to do.
            continue


if __name__ == "__main__":
    main()
