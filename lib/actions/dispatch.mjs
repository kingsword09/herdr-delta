// delta.bridge dispatch — orchestrate one full task round through Delta's
// execution substrate, with a pluggable engine.
//
// Usage (invoked as a plugin action; argv after the action id is the task):
//   delta.bridge.dispatch <TASK> [options]
//
// Options:
//   --engine delta|terminal   delta: record the plan, human presses Send in
//                             the GUI, Delta's own agent executes.
//                             terminal: run a headless agent inside the
//                             mounted checkout (default).
//   --agent NAME              terminal engine executor: codex|claude|zcode
//   --model M / --effort E    passed through to the terminal agent
//   --merge direct|pr-squash  remembered for finalize (default direct)
//   --reviewer PANE_ID        pane whose agent reviews when the round ends
//   --cwd DIR                 project directory to attach (default: workspace
//                             project, i.e. first pane cwd)
//
// Round shape (both engines share steps 1-3 and 5-6):
//   1. create thread bound to this workspace, attach the project
//   2. mount an isolated checkout; a cleanup guard guarantees ANY exit path
//      (success, die, INT/TERM) both returns the checkout and closes a
//      half-open recorded turn
//   3. record the task into the thread
//   4. execute (delta: GUI + daemon watches; terminal: headless agent)
//   5. unmount: changes upload into thread history and land in the project
//      working tree as uncommitted changes
//   6. nudge the reviewer pane to start review

import fs from "node:fs";
import path from "node:path";
import {
  STATE_DIR, CONFIG_DIR, finalizeFile, readEnvFile, writeEnvFile,
  workspaceExternalId, die, run,
} from "../common.mjs";
import { DELTA, requireDelta, deltaJson, Recorder } from "../delta.mjs";
import { HERDR, agentPrompt, paneSendText, workspaceProjectDir } from "../herdr.mjs";
import { runTerminalAgent, checkAgentAvailable } from "../agents.mjs";
import { EventMapper } from "../agent-events.mjs";

requireDelta();

// Warn about a previous round that was never landed: its uncommitted
// changes still sit in the project tree and a finalize record is pending.
const ff = finalizeFile();
if (fs.existsSync(ff)) {
  const prev = readEnvFile(ff);
  const prevDir = prev.get("PROJECT_DIR");
  if (prevDir) {
    const dirty = run("git", ["-C", prevDir, "status", "--porcelain"]);
    if (dirty.stdout.trim()) {
      console.error(`delta.bridge: NOTE uncommitted changes from a previous round are still in ${prevDir}`);
      console.error(`delta.bridge:      (thread ${prev.get("THREAD_ID") ?? "?"}); run finalize first if you want them landed before this round`);
    }
  }
}

// ---------- arg parse ----------
const taskParts = [];
const opts = { engine: "", agent: "codex", model: "", effort: "", merge: "", reviewer: "" };
let projectDir = process.env.DELTA_PROJECT ?? "";
const args = process.argv.slice(2);
while (args.length > 0) {
  const a = args.shift();
  switch (a) {
    case "--engine": opts.engine = args.shift(); break;
    case "--agent": opts.agent = args.shift(); break;
    case "--model": opts.model = args.shift(); break;
    case "--effort": opts.effort = args.shift(); break;
    case "--merge": opts.merge = args.shift(); break;
    case "--reviewer": opts.reviewer = args.shift(); break;
    case "--cwd": projectDir = args.shift(); break;
    default:
      if (a.startsWith("-")) die(`unknown option: ${a}`);
      taskParts.push(a);
  }
}
const task = taskParts.join(" ");
if (!task) die('no task given: dispatch "<task text>"');
// Default engine from the plugin config dir (overridable per user).
if (!opts.engine) {
  const engineCfg = path.join(CONFIG_DIR, "engine");
  opts.engine = fs.existsSync(engineCfg) ? fs.readFileSync(engineCfg, "utf8").trim() : "terminal";
}

// Resolve the project directory the same way `open` does.
if (!projectDir) projectDir = workspaceProjectDir() ?? "";
if (!projectDir) die("no project directory; pass --cwd or run inside a project workspace");
if (run("git", ["-C", projectDir, "rev-parse", "--is-inside-work-tree"]).rc !== 0) {
  die(`${projectDir} is not a Git checkout`);
}

// 1. thread for this task, bound to the workspace, project attached.
const ext = `${workspaceExternalId()}-task-${Date.now()}-${process.pid}`;
const tid = deltaJson(["thread", "create", "--source", "herdr",
  "--external-id", ext]).thread_id;
if (!tid) die("thread create failed");
// append refuses unshared threads (server-confirmed receipts).
run(DELTA, ["thread", "share", tid, "--visibility", "organization"]);
run(DELTA, ["worktree", "attach", projectDir, "--thread", tid]);

// 2. borrow an isolated checkout. mounted/roundOpen drive the cleanup
//    guard installed below, which runs on every exit path.
const owner = `dispatch-${ext}`;
const rec = new Recorder(tid, ext);
let mounted = false;

const roundCleanup = () => {
  rec.closeTurn(); // no-op unless a recorded turn is still open
  if (mounted) {
    run(DELTA, ["thread", "unmount", tid, "--owner", owner]);
    mounted = false;
  }
};
process.on("exit", roundCleanup);
process.on("SIGINT", () => { roundCleanup(); process.exit(130); });
process.on("SIGTERM", () => { roundCleanup(); process.exit(143); });

const mountJson = deltaJson(["thread", "mount", tid, "--owner", owner,
  "--owner-pid", String(process.pid), "--json"]);
const checkout = mountJson.directory;
if (!checkout || !fs.existsSync(checkout)) die("mount returned no checkout directory");
mounted = true;

// 3. record the task (and dispatch metadata) as the opening of the round.
rec.openTurn();
rec.message("user_message", "task", `[delta-bridge]: ${task}`);

console.log(`thread:   ${tid}`);
console.log(`checkout: ${checkout}`);
console.log(`engine:   ${opts.engine} (merge: ${opts.merge || "direct"})`);

// 4. execute
if (opts.engine === "delta") {
  // Human-in-the-loop: focus the app; the daemon watches this round's task
  // thread and nudges the reviewer when the GUI turn goes back to idle.
  run(DELTA, ["open", tid]);
  writeEnvFile(path.join(STATE_DIR, `round-${ext}.env`), {
    THREAD_ID: tid, ENGINE: "delta", MERGE: opts.merge || "direct",
    REVIEWER: opts.reviewer, CHECKOUT: checkout, PROJECT_DIR: projectDir,
    WS_EXTERNAL: workspaceExternalId(),
  });
  console.log("recorded the task; press Send in Delta to execute, the reviewer will be nudged when the turn completes");
  process.exit(0); // cleanup guard returns the checkout; GUI round continues
}

// Headless execution inside the mounted checkout. Structured agents
// (codex --json, claude stream-json) are translated into Delta's native
// items as their events arrive, so the thread renders like a native Delta
// turn (thinking blocks + tool cards) instead of a terminal dump.
checkAgentAvailable(opts.agent);
const logFile = path.join(STATE_DIR, `exec-${ext}.log`);
const mapper = new EventMapper(rec, opts.agent);
await runTerminalAgent({
  ...opts, task, checkout, logFile,
  onLine: (line) => mapper.feed(line),
});
const result = mapper.finish(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "");
if (!result.structured && !result.text) {
  // Text-mode agent produced nothing usable: keep the raw tail so the
  // failure is visible in the thread instead of an empty turn.
  let tail = "";
  try {
    tail = fs.readFileSync(logFile, "utf8").slice(-2000).trim();
  } catch { /* no log */ }
  if (tail) rec.message("agent_message", "exec", `[herdr]: raw output\n\n${tail}`);
}
// Close the turn on the happy path too (no-op if the guard already did).
rec.closeTurn();

// 5. return the checkout; changes upload into thread history and appear in
//    the project working tree as uncommitted changes.
roundCleanup();

// 6a. terminal rounds end here; nudge the reviewer immediately.
if (opts.reviewer) {
  const reviewMsg = `Delta round finished (thread ${tid}). Review uncommitted changes in ${projectDir} (git diff) or open the thread in Delta; run delta.bridge.finalize --mode ${opts.merge || "direct"} when satisfied.`;
  if (agentPrompt(opts.reviewer, reviewMsg, [], 30_000).rc !== 0) {
    paneSendText(opts.reviewer, reviewMsg);
  }
}

// Record what finalize needs (6b: delta-engine rounds get nudged by the
// daemon when the GUI turn completes).
writeEnvFile(finalizeFile(), {
  THREAD_ID: tid, MERGE: opts.merge || "direct", PROJECT_DIR: projectDir,
});

console.log(`dispatch round complete; uncommitted changes are in ${projectDir}`);
