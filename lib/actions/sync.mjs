// delta.bridge sync — bind the invoking pane's agent to the workspace's
// Delta thread, then hand off to the long-running bridge daemon.
//
// Direction 1 (Delta -> herdr): the daemon watches the thread; user
//   messages typed in the Delta app are submitted to the pane's agent with
//   `herdr agent prompt --wait`, and the reply is appended to the thread.
// Direction 2 (herdr -> Delta): agents in this workspace can record into
//   the same thread by piping JSONL into `delta thread append` (see README).
//
// One bridge per workspace. Re-running re-binds to the current pane.

import fs from "node:fs";
import { bindingFile, readEnvFile, writeEnvFile, workspaceExternalId, die } from "../common.mjs";
import { DELTA, requireDelta, deltaJson } from "../delta.mjs";
import { HERDR, currentPaneId, agentRename } from "../herdr.mjs";
import { saveBinding } from "../binding.mjs";

requireDelta();

const pane = currentPaneId();
if (!pane) die("no pane in context; invoke from a pane");

// Ensure a thread binding exists (create + share if needed).
const bf = bindingFile();
let tid;
if (fs.existsSync(bf)) {
  tid = readEnvFile(bf).get("THREAD_ID");
} else {
  tid = deltaJson(["thread", "create", "--source", "herdr",
    "--external-id", workspaceExternalId()]).thread_id;
  if (!tid) die("thread create returned no id");
  saveBinding(tid);
}

// Persist which pane this workspace's bridge drives; the daemon reads it.
writeEnvFile(bf, { PANE_ID: pane });

// Surface the bridge in herdr's sidebar.
agentRename(pane, "delta-bridge");

console.log(`bridge armed for pane ${pane} <-> thread ${tid}`);
console.log("messages sent from the Delta app will drive this pane's agent");
