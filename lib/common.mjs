// Shared helpers: paths, env-style state files, herdr context.
// Node API compatible — runs under node >= 20 and bun.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ??
  path.join(os.homedir(), ".local/state/herdr-delta");
export const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR ??
  path.join(os.homedir(), ".config/herdr/plugins/config/delta.bridge");
export const BRIDGE_SOURCE = "herdr";

fs.mkdirSync(STATE_DIR, { recursive: true });

export function die(message) {
  process.stderr.write(`delta.bridge: ${message}\n`);
  process.exit(1);
}

// ---------- env-style state files (KEY=VALUE, last match wins) ----------

export function readEnvFile(file) {
  const map = new Map();
  let body;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return map; // missing file is an empty record, not an error
  }
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, ""));
  }
  return map;
}

// Merge-write like the shell version: drop keys we own, keep the rest once
// (first occurrence, matching `awk '!seen[$1]++'`), then append the new pair.
export function writeEnvFile(file, updates) {
  const owned = new Set(Object.keys(updates));
  const kept = [];
  const seen = new Set();
  for (const [k, v] of readEnvFile(file)) {
    if (owned.has(k) || seen.has(k)) continue;
    seen.add(k);
    kept.push(`${k}=${v}`);
  }
  const body = [...kept, ...Object.entries(updates).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n";
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

export function deleteFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

// ---------- herdr context ----------

export function workspaceExternalId() {
  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!ws) die("no herdr workspace context");
  return `herdr-${ws}`;
}

export function bindingFile() {
  return path.join(STATE_DIR, `binding-${workspaceExternalId()}.env`);
}

export function finalizeFile() {
  return path.join(STATE_DIR, `finalize-${workspaceExternalId()}.env`);
}

export function requireBinding() {
  const bf = bindingFile();
  if (!fs.existsSync(bf)) {
    die("no Delta thread bound to this workspace yet; run the 'open' or 'sync' action first");
  }
  const b = readEnvFile(bf);
  if (!b.get("THREAD_ID")) die(`binding file ${bf} has no THREAD_ID`);
  return b;
}

// ---------- process helpers ----------

// Run a command, return { rc, stdout, stderr }. Never throws.
export function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (r.error) return { rc: 127, stdout: "", stderr: String(r.error) };
  return { rc: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function lines(stdout) {
  return stdout ? stdout.split("\n").filter((l) => l.trim()) : [];
}

// PATH lookup without shell: true (which node deprecates with args).
export function haveBinary(bin) {
  const r = run("/usr/bin/env", ["which", bin]);
  return r.rc === 0 && r.stdout.trim().length > 0;
}
