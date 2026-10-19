// delta.bridge mount — keep the bound Delta thread's worktrees mounted for
// this herdr workspace, so pane agents can work on the thread's checkout.
//
// Checkouts are deleted when the owner process exits, so the owner is the
// herdr server's PID (mount outlives any one action). Match by exact
// executable name so an editor buffer named "herdr-server.md" never matches.

import { run } from "../common.mjs";
import { requireBinding, workspaceExternalId, die } from "../common.mjs";
import { DELTA, requireDelta } from "../delta.mjs";

requireDelta();
const binding = requireBinding();
const tid = binding.get("THREAD_ID");

const owner = `herdr-${workspaceExternalId()}`;
let serverPid = "";
const ps = run("ps", ["-eo", "pid,comm"]);
for (const line of ps.stdout.split("\n")) {
  if (/\/herdr$/.test(line.trim().split(/\s+/).slice(1).join(" "))) {
    serverPid = line.trim().split(/\s+/)[0];
    break;
  }
}

let r;
if (serverPid && run("kill", ["-0", serverPid]).rc === 0) {
  r = run(DELTA, ["thread", "mount", tid, "--owner", owner, "--owner-pid", serverPid]);
} else {
  r = run(DELTA, ["thread", "mount", tid, "--owner", owner]);
}
if (r.rc !== 0) die(`mount failed: ${r.stderr.trim()}`);

console.log(`Delta checkout mounted for owner ${owner}`);
console.log("hint: 'delta thread list-worktrees <join_id>' shows the mountable worktrees");
