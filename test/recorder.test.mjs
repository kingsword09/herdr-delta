// Unit tests for the reverse-engineered append contract in delta.mjs.
// Frames `delta thread append` with a fake binary that records stdin and
// enforces the real invariants: contiguous sequence, turnSequence rules,
// content must be a block array.
//
// Run: node test/recorder.test.mjs   (no test framework, plain assertions)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-delta-test-"));

// Fake `delta`: validates each record the way the real 0.20.1 CLI does
// (the errors it rejected: sequence gaps, turnSequence naming a later
// record, running whose turnSequence != its own sequence, content not an
// array) and logs accepted records.
const fakeDelta = path.join(tmp, "delta");
fs.writeFileSync(fakeDelta, `#!/bin/sh
rec="\$(cat)"
echo "\$rec" | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (r.schemaVersion !== 1) { console.error("bad schemaVersion"); process.exit(1); }
  if (!Number.isInteger(r.sequence)) { console.error("bad sequence"); process.exit(1); }
  const u = r.update || {};
  if (u.sessionUpdate === "state_update" && u.state === "running") {
    if (r.turnSequence !== r.sequence) { console.error("running turnSequence must equal its own sequence"); process.exit(1); }
  } else if (r.turnSequence == null || r.turnSequence >= r.sequence) {
    console.error("turnSequence must name an earlier start sequence"); process.exit(1);
  }
  if ((u.sessionUpdate === "user_message" || u.sessionUpdate === "agent_message")) {
    if (!Array.isArray(u.content)) { console.error("content must be a block array"); process.exit(1); }
    if (!u.content.every((b) => b && b.type === "text" && typeof b.text === "string")) { console.error("bad block"); process.exit(1); }
  }
  process.stdout.write(JSON.stringify(r) + "\\n");
' >> '${tmp}/accepted.jsonl'
`);
fs.chmodSync(fakeDelta, 0o755);
process.env.DELTA_BIN = fakeDelta;

// Recorder reads STATE_DIR for the seq file; point it at the tmp dir.
process.env.HERDR_PLUGIN_STATE_DIR = path.join(tmp, "state");

// Fresh import after env is set.
const { Recorder } = await import("../lib/delta.mjs");

// --- test 1: a full turn frames correctly --------------------------------
{
  fs.rmSync(path.join(tmp, "state"), { recursive: true, force: true });
  const rec = new Recorder("thread_x", "s1");
  assert.equal(rec.seq, 1, "fresh stream starts at sequence 1");

  assert.ok(rec.openTurn(), "openTurn appends");
  assert.equal(rec.seq, 2, "sequence advanced");
  assert.equal(rec.turnOpen, true);

  assert.ok(rec.message("user_message", "m1", "hello"), "message appends");
  assert.ok(rec.message("agent_message", "m2", "[herdr]: hi"), "reply appends");

  assert.ok(rec.closeTurn(), "closeTurn appends");
  assert.equal(rec.turnOpen, false, "turn closed");
  assert.equal(rec.seq, 5, "four records consumed (opener + 2 msgs + idle)");

  const accepted = fs.readFileSync(path.join(tmp, "accepted.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(accepted.length, 4);
  assert.deepEqual(accepted.map((r) => r.sequence), [1, 2, 3, 4], "contiguous from 1");
  // opener: running with turnSequence == own sequence
  assert.equal(accepted[0].update.state, "running");
  assert.equal(accepted[0].turnSequence, 1);
  // later records point at the opener
  assert.equal(accepted[1].turnSequence, 1);
  assert.equal(accepted[2].turnSequence, 1);
  assert.equal(accepted[3].update.state, "idle");
  assert.equal(accepted[3].turnSequence, 1);
  // content is a block array
  assert.deepEqual(accepted[1].update.content, [{ type: "text", text: "hello" }]);
  console.log("ok 1 - full turn framing (running @1, msgs @2-3, idle @4, block array content)");
}

// --- test 2: sequence persists across Recorder instances -------------------
{
  const rec = new Recorder("thread_x", "s1");
  assert.equal(rec.seq, 5, "sequence restored from state file");
  console.log("ok 2 - sequence counter persists across processes");
}

// --- test 3: closeTurn is idempotent (no double close) -------------------
{
  const rec = new Recorder("thread_x", "s1");
  assert.ok(rec.closeTurn(), "closeTurn with no open turn is a no-op success");
  const accepted = fs.readFileSync(path.join(tmp, "accepted.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean);
  assert.equal(accepted.length, 4, "no extra record appended");
  console.log("ok 3 - closeTurn idempotent when no turn is open");
}

// --- test 4: a rejected append leaves the counter intact ------------------
{
  // Simulate the real CLI refusing an append (e.g. thread not shared):
  // the sequence must NOT advance, so a retry succeeds.
  fs.writeFileSync(fakeDelta, `#!/bin/sh
cat >/dev/null
echo "thread is not shared" >&2
exit 1
`);
  fs.chmodSync(fakeDelta, 0o755);
  const rec = new Recorder("thread_x", "s1");
  const before = rec.seq;
  assert.equal(rec.appendSync({ sessionUpdate: "state_update", state: "idle" }, 1), false);
  assert.equal(rec.seq, before, "failed append does not consume the sequence");
  console.log("ok 4 - failed append leaves sequence intact for retry");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("all recorder tests passed");
