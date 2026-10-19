// `herdr` CLI wrapper: panes, agents, prompting.

import { run } from "./common.mjs";

export const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";

export function herdr(args, opts = {}) {
  return run(HERDR, args, opts);
}

// Run a herdr command and parse JSON stdout; null on any failure.
export function herdrJson(args) {
  const r = herdr(args);
  if (r.rc !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

export function paneList() {
  return herdrJson(["pane", "list"])?.result?.panes ?? [];
}

// The pane the plugin action was invoked on: explicit env, else focused.
export function currentPaneId() {
  if (process.env.HERDR_PANE_ID) return process.env.HERDR_PANE_ID;
  return paneList().find((p) => p.focused)?.pane_id ?? null;
}

// First pane cwd of the current workspace: how the plugin resolves which
// project a workspace belongs to.
export function workspaceProjectDir() {
  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!ws) return null;
  const pane = paneList().find((p) => p.workspace_id === ws);
  return pane?.cwd || pane?.foreground_cwd || null;
}

export function paneRead(paneId, linesCount = 200) {
  const r = herdr(["pane", "read", paneId, "--lines", String(linesCount)], { timeout: 30_000 });
  return r.rc === 0 ? r.stdout : "";
}

export function agentRename(paneId, name) {
  herdr(["agent", "rename", paneId, name]);
}

export function agentPrompt(paneId, message, extraArgs = [], timeoutMs = 30_000) {
  return herdr(["agent", "prompt", paneId, message, ...extraArgs], { timeout: timeoutMs });
}

export function paneSendText(paneId, text) {
  return herdr(["pane", "send-text", paneId, text]);
}
