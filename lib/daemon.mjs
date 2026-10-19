// delta.bridge startup daemon — message bridges plus open dispatch rounds.
//
// Two kinds of watches, one per thread:
//   1. workspace bridges armed by the `sync` action (binding-*.env)
//   2. open engine=delta dispatch rounds (round-*.env with ENGINE=delta);
//      dispatch removes the round file when its round ends, which also ends
//      this watch
//
// In-process child supervision: each watch is one `delta thread watch` child
// feeding one bridge-loop child. Both die with the daemon; no pid files.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { STATE_DIR, readEnvFile, run } from "./common.mjs";
import { haveDelta } from "./delta.mjs";

if (!haveDelta()) process.exit(0); // nothing to bridge without the delta CLI

const LOOP = path.resolve(import.meta.dirname, "bridge-loop.mjs");
const watches = new Map(); // key -> { children: [ChildProcess], dead: bool }

function stopAll() {
  for (const w of watches.values()) {
    for (const c of w.children) {
      try {
        c.kill("SIGTERM");
      } catch { /* already dead */ }
    }
  }
  process.exit(0);
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

function startWatch(key, env) {
  const existing = watches.get(key);
  if (existing && !existing.dead) return;

  // delta thread watch | bridge-loop (env carries the context)
  const watch = spawn("delta", ["thread", "watch", env.BRIDGE_THREAD_ID], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const loop = spawn(process.execPath, [LOOP], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  watch.stdout.pipe(loop.stdin);
  // If either side dies the pipeline is broken: mark dead so the scan
  // restarts it (dispatch removes round files; bindings persist).
  const markDead = () => {
    const w = watches.get(key);
    if (w) w.dead = true;
    try { loop.kill("SIGTERM"); } catch { /* gone */ }
    try { watch.kill("SIGTERM"); } catch { /* gone */ }
  };
  watch.on("exit", markDead);
  loop.on("exit", markDead);
  watches.set(key, { children: [watch, loop], dead: false });
}

function scan() {
  let names;
  try {
    names = fs.readdirSync(STATE_DIR);
  } catch {
    return;
  }

  // 1. workspace bridges
  for (const name of names) {
    if (!name.startsWith("binding-") || !name.endsWith(".env")) continue;
    const wsExternal = name.slice("binding-".length, -".env".length);
    const b = readEnvFile(path.join(STATE_DIR, name));
    if (!b.get("THREAD_ID")) continue;
    startWatch(`ws:${wsExternal}`, {
      BRIDGE_WS_EXTERNAL: wsExternal,
      BRIDGE_THREAD_ID: b.get("THREAD_ID"),
      BRIDGE_EXTRA_ID: "bridge",
    });
  }

  // 2. open engine=delta dispatch rounds
  for (const name of names) {
    if (!name.startsWith("round-") || !name.endsWith(".env")) continue;
    const ext = name.slice("round-".length, -".env".length);
    const r = readEnvFile(path.join(STATE_DIR, name));
    if (r.get("ENGINE") !== "delta" || !r.get("THREAD_ID")) continue;
    const wsExternal = r.get("WS_EXTERNAL") ?? ext.split("-task-")[0];
    startWatch(`round:${ext}`, {
      BRIDGE_WS_EXTERNAL: wsExternal,
      BRIDGE_THREAD_ID: r.get("THREAD_ID"),
      BRIDGE_EXTRA_ID: `round-${ext}`,
      BRIDGE_ROUND_THREAD_ID: r.get("THREAD_ID"),
    });
  }
}

setInterval(scan, 2000);
scan();
