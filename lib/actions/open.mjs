// delta.bridge open — open or create the Delta thread bound to this herdr
// workspace, and focus it in the Delta app.
//
// Behavior:
//   - Link handler (HERDR_PLUGIN_CLICKED_URL): open that join id.
//   - Existing binding: open the bound thread.
//   - Pane output contains a delta.dev/join/<id> link: adopt it.
//   - Else create a fresh recorded thread bound to this workspace.

import fs from "node:fs";
import {
  ROOT, die, readEnvFile, run, bindingFile, workspaceExternalId,
} from "../common.mjs";
import { DELTA, requireDelta, deltaJson } from "../delta.mjs";
import { HERDR, currentPaneId, paneRead, workspaceProjectDir } from "../herdr.mjs";
import { saveBinding } from "../binding.mjs";

requireDelta();

const clicked = process.env.HERDR_PLUGIN_CLICKED_URL ?? "";
if (clicked) {
  const m = clicked.match(/delta\.dev\/join\/(thread_[A-Za-z0-9]+)$/);
  if (!m) die(`unrecognized Delta link: ${clicked}`);
  const r = run(DELTA, ["open", m[1]]);
  if (r.rc !== 0) die(`could not open ${m[1]} in Delta`);
  console.log(`opened ${m[1]} in Delta`);
  process.exit(0);
}

const bf = bindingFile();
if (fs.existsSync(bf)) {
  const tid = readEnvFile(bf).get("THREAD_ID");
  const r = run(DELTA, ["open", tid]);
  if (r.rc !== 0) die(`could not open bound thread ${tid}`);
  console.log(`opened bound thread ${tid}`);
  process.exit(0);
}

// Scan the current pane output for a join link to adopt.
const pane = currentPaneId();
if (pane) {
  const out = paneRead(pane, 200);
  const links = out.match(/delta\.dev\/join\/thread_[A-Za-z0-9]+/g) ?? [];
  if (links.length > 0) {
    const jid = links[links.length - 1].split("/join/")[1];
    const r = run(DELTA, ["open", jid]);
    if (r.rc !== 0) die(`could not open ${jid} in Delta`);
    console.log(`adopted join id ${jid} (from pane output)`);
    process.exit(0);
  }
}

// Fresh recorded thread bound to this workspace, attached to the
// workspace's project so it lands under that project in Delta.
const tid = deltaJson(["thread", "create", "--source", "herdr",
  "--external-id", workspaceExternalId()]).thread_id;
if (!tid) die("thread create returned no id");

const projectDir = process.env.DELTA_PROJECT || workspaceProjectDir();
let attached = false;
if (projectDir && run("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"]).rc === 0) {
  // attach is idempotent for a directory already bound to this thread
  run(DELTA, ["worktree", "attach", projectDir, "--thread", tid]);
  attached = true;
}
if (!attached) {
  console.error("note: no Git checkout found for this workspace; thread created as a plain conversation");
}
saveBinding(tid);
run(DELTA, ["open", tid]);
console.log(`created and opened Delta thread ${tid}`);
if (projectDir) console.log(`project: ${projectDir}`);
