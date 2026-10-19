// One bridge between one herdr workspace and one Delta thread, fed by
// `delta thread watch` JSONL on stdin.
//
// For each user message written in the Delta app (prefixed
// "[delta-bridge]: "), submit it to the bound pane's agent via
// `herdr agent prompt --wait`, then append the agent's reply back into the
// thread (and close the turn) via `delta thread append`.
//
// Also watches turn state for engine=delta dispatch rounds: when the GUI
// turn goes back to idle, nudge the reviewer pane once.

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, readEnvFile } from "./common.mjs";
import { Recorder } from "./delta.mjs";
import {
  HERDR, agentPrompt, paneSendText, paneRead,
} from "./herdr.mjs";
import { narrative } from "./agent-narrative.mjs";

const WATCH_USER = "delta-bridge"; // sender prefix we recognize from the app
const BINDING_PREFIX = "binding-";
const ROUND_PREFIX = "round-";

// ---------- per-(workspace) state passed via env from the daemon ----------

const wsExternal = process.env.BRIDGE_WS_EXTERNAL; // e.g. herdr-w1
const threadId = process.env.BRIDGE_THREAD_ID;
// extra stream id for appends (distinct from dispatch's task stream):
// workspace bridges use "bridge", round watchers use "round-<ext>".
const extraId = process.env.BRIDGE_EXTRA_ID ?? "bridge";
// non-empty when this watch is supervising an engine=delta dispatch round
const roundThreadId = process.env.BRIDGE_ROUND_THREAD_ID ?? "";

if (!wsExternal || !threadId) {
  console.error("bridge-loop: missing BRIDGE_WS_EXTERNAL/BRIDGE_THREAD_ID");
  process.exit(1);
}
const BINDING = path.join(STATE_DIR, `${BINDING_PREFIX}${wsExternal}.env`);
const SEEN_FILE = path.join(STATE_DIR, `seen-${wsExternal}-${threadId}.txt`);
const rec = new Recorder(threadId, `${wsExternal}-${extraId}`);

function binding(key) {
  return readEnvFile(BINDING).get(key) ?? null;
}

function paneId() {
  return binding("PANE_ID"); // re-read each time: `sync` can retarget
}

function seen(id) {
  try {
    return fs.readFileSync(SEEN_FILE, "utf8").split(/\s/).includes(id);
  } catch {
    return false;
  }
}

function markSeen(id) {
  fs.appendFileSync(SEEN_FILE, `${id}\n`);
}

function agentReplyText() {
  const pane = paneId();
  if (!pane) return "";
  const r = paneRead(pane, 80);
  return r;
}

// Pane snapshots are full of box-drawing borders and status bars; keep
// only the agent's actual words.
function paneNarrative(paneOut) {
  return narrative(paneOut).slice(-4000).trim();
}

function nudgeReviewer(message) {
  const pane = binding("REVIEWER") || paneId();
  if (!pane) return;
  if (agentPrompt(pane, message, [], 30_000).rc !== 0) paneSendText(pane, message);
}

// Thread ids of open engine=delta dispatch rounds (round-*.env files).
function roundThreadIds() {
  const ids = new Set();
  let names;
  try {
    names = fs.readdirSync(STATE_DIR);
  } catch {
    return ids;
  }
  for (const name of names) {
    if (!name.startsWith(ROUND_PREFIX) || !name.endsWith(".env")) continue;
    const body = readEnvFile(path.join(STATE_DIR, name));
    if (body.get("ENGINE") !== "delta") continue;
    const tid = body.get("THREAD_ID");
    if (tid) ids.add(tid);
  }
  return ids;
}

// ---------- watch loop ----------
// The daemon pipes `delta thread watch` into our stdin; parse that. (The
// loop never spawns its own watch — that would duplicate the pipeline.)

let exiting = false;
const stop = () => {
  if (exiting) return;
  exiting = true;
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// stdin ends => the daemon's watch child died; the daemon restarts both.
process.stdin.on("end", () => process.exit(0));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  line = line.trim();
  if (!line) return;
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return;
  }

  if (ev.type === "turn") {
    // engine=delta rounds: the human pressed Send in the GUI; when the
    // turn goes back to idle the round is done — nudge the reviewer once.
    if (roundThreadId !== threadId && !roundThreadIds().has(threadId)) return;
    const state = (ev.state ?? "").trim();
    if (state === "idle" || state === "done") {
      nudgeReviewer(`Delta round finished on thread ${threadId}. Review the uncommitted changes (git diff in the project, or open the thread in Delta); run delta.bridge.finalize when satisfied.`);
    }
    return;
  }

  if (ev.type !== "item") return; // presence/worktrees/children: informational
  const item = ev.item ?? {};
  const iid = item.id;
  if (!iid || seen(iid)) return;
  markSeen(iid);

  if (item.kind !== "user_message") return;
  const text = (item.content?.text ?? "").trim();
  if (!text) return;
  if (!text.startsWith(`[${WATCH_USER}]`)) return; // only relay bridge messages
  const prompt = text.replace(new RegExp(`^\\[${WATCH_USER}\\]:?\\s*`), "");
  const pane = paneId();
  if (!pane) return;

  // Open a recorded turn, submit, close with a cleaned reply (the pane
  // snapshot contains ANSI borders/status bars; keep only what the agent
  // actually said).
  if (!rec.openTurn()) return;
  agentPrompt(pane, prompt, ["--wait", "--until", "idle", "--until", "done"], 1_200_000);
  const reply = paneNarrative(agentReplyText());
  rec.message("agent_message", `r-${Date.now()}`, `[herdr]: ${reply}`);
  rec.closeTurn();
});
