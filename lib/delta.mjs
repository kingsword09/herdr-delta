// `delta` CLI wrapper plus the reverse-engineered append contract
// (Delta 0.20.1, recording schemaVersion 1):
//   - envelope {"schemaVersion":1,"sequence":N,"turnSequence":M,"update":{...}}
//   - sequence contiguous per (source, external-id) stream, starting at 1
//   - a turn opens with state_update running whose turnSequence == its own
//     sequence; every later record of the turn points at the opener; the
//     turn closes with state_update idle
//   - message content MUST be a block array (a bare object parses but
//     renders as an empty buffer)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATE_DIR, die, run, haveBinary } from "./common.mjs";

export const DELTA = process.env.DELTA_BIN ?? "delta";

export function haveDelta() {
  return haveBinary(DELTA);
}

export function requireDelta() {
  if (!haveDelta()) {
    die("delta CLI not found on PATH; run: ln -sfn /Applications/Delta.app/Contents/MacOS/delta ~/.local/bin/delta");
  }
}

// Run delta, parse its JSON stdout. die(message) on failure.
export function deltaJson(args, { okRc = [0] } = {}) {
  const r = run(DELTA, args);
  if (!okRc.includes(r.rc)) die(`delta ${args[0]} failed: ${r.stderr.trim() || `rc=${r.rc}`}`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    die(`delta ${args[0]}: unparseable output: ${e.message}`);
  }
}

// Long-running `delta thread watch`, returns the ChildProcess.
export function deltaWatch(threadId) {
  return spawn(DELTA, ["thread", "watch", threadId], { stdio: ["ignore", "pipe", "ignore"] });
}

// ---------- append-stream recorder ----------

// One append stream = (thread, source, external-id) with its own contiguous
// sequence counter persisted next to the other plugin state.
export class Recorder {
  constructor(threadId, externalId) {
    this.threadId = threadId;
    this.externalId = externalId;
    this.seqFile = path.join(STATE_DIR, `seq-${externalId}.txt`);
    this.seq = 1;
    try {
      this.seq = parseInt(fs.readFileSync(this.seqFile, "utf8").trim(), 10);
    } catch { /* fresh stream */ }
    this.turnOpen = false;
  }

  appendSync(update, turnSeq) {
    const record = {
      schemaVersion: 1,
      sequence: this.seq,
      turnSequence: turnSeq ?? this.seq,
      update,
    };
    // spawnSync keeps ordering and lets signal handlers finish their work.
    const r = spawnSync(DELTA, ["thread", "append", this.threadId,
      "--source", "herdr", "--external-id", this.externalId], {
      input: JSON.stringify(record),
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.status !== 0) {
      return false;
    }
    this.seq += 1;
    fs.mkdirSync(path.dirname(this.seqFile), { recursive: true });
    fs.writeFileSync(this.seqFile, String(this.seq));
    return true;
  }

  openTurn() {
    if (this.turnOpen) return true;
    const ok = this.appendSync({ sessionUpdate: "state_update", state: "running" });
    this.turnOpenSeq = this.seq - 1; // the opener's own sequence
    this.turnOpen = ok;
    return ok;
  }

  closeTurn() {
    if (!this.turnOpen) return true;
    const ok = this.appendSync(
      { sessionUpdate: "state_update", state: "idle" },
      this.turnOpenSeq,
    );
    if (ok) this.turnOpen = false;
    return ok;
  }

  message(kind, messageId, text) {
    return this.appendSync({
      sessionUpdate: kind,
      messageId,
      content: [{ type: "text", text }], // block array, never a bare object
    }, this.turnOpen ? this.turnOpenSeq : undefined);
  }

  // Reasoning step. `messageId` is REQUIRED — without it the recorder
  // rejects the update ("data did not match any variant"); with it Delta
  // renders a Thinking block and aggregates "Thought N times".
  thought(messageId, text) {
    return this.appendSync({
      sessionUpdate: "agent_thought",
      messageId,
      content: [{ type: "text", text }],
    }, this.turnOpen ? this.turnOpenSeq : undefined);
  }

  // First-class tool call card in the Delta UI. Only toolCallId is
  // required by the recorder; content/locations shape is probed-valid:
  //   content: [{type:"content", content:{type:"text", text}}...]
  //   locations: [{path, line?}...]
  toolCall({ toolCallId, title, kind, status = "completed", text, locations, rawInput, rawOutput }) {
    const update = { sessionUpdate: "tool_call_update", toolCallId, status };
    if (title != null) update.title = title;
    if (kind != null) update.kind = kind;
    if (rawInput != null) update.rawInput = rawInput;
    if (rawOutput != null) update.rawOutput = rawOutput;
    update.content = text != null
      ? [{ type: "content", content: { type: "text", text } }]
      : [];
    update.locations = locations ?? [];
    return this.appendSync(update, this.turnOpen ? this.turnOpenSeq : undefined);
  }
}
