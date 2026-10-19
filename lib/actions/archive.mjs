// delta.bridge archive — record the invoking pane's recent terminal output
// into the bound Delta thread as a snapshot, so the session shows up in
// `delta thread search` and can be reviewed alongside the code.
//
// The archive uses its own append stream (external-id archive-<pane>) so
// re-archiving the same pane continues one contiguous sequence.

import { workspaceExternalId, requireBinding, die } from "../common.mjs";
import { requireDelta, Recorder } from "../delta.mjs";
import { currentPaneId, paneRead } from "../herdr.mjs";

requireDelta();
const binding = requireBinding();
const tid = binding.get("THREAD_ID");

const pane = currentPaneId();
if (!pane) die("no pane in context; invoke from a pane");

const linesCount = process.env.DELTA_ARCHIVE_LINES ?? "200";
const snapshot = paneRead(pane, Number(linesCount));
if (!snapshot) die(`no output to archive from pane ${pane}`);

const rec = new Recorder(tid, `${workspaceExternalId()}-archive-${pane}`);
// one self-contained turn: running -> agent_message(snapshot) -> idle
rec.openTurn();
rec.message("agent_message",
  `archive-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
  `[herdr]: pane archive\n\n${snapshot}`);
rec.closeTurn();

console.log(`archived ${linesCount} lines of pane ${pane} into thread ${tid}`);
