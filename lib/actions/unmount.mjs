// delta.bridge unmount — release this workspace's mounts of the bound
// thread once the agents are done and their changes are uploaded.

import { run, requireBinding, workspaceExternalId, die } from "../common.mjs";
import { DELTA, requireDelta } from "../delta.mjs";

requireDelta();
const tid = requireBinding().get("THREAD_ID");

const owner = `herdr-${workspaceExternalId()}`;
const r = run(DELTA, ["thread", "unmount", tid, "--owner", owner]);
if (r.rc !== 0) die(`unmount failed: ${r.stderr.trim()}`);

console.log(`released ${owner}'s mounts of ${tid}`);
console.log("hint: open the thread in Delta to review and sync the agents' changes");
