// Binding helpers: ensure the workspace thread is shared (append refuses
// unshared threads) and persist THREAD_ID in the workspace binding file.

import { run } from "./common.mjs";
import { bindingFile, writeEnvFile } from "./common.mjs";
import { DELTA } from "./delta.mjs";

export function saveBinding(tid) {
  const r = run(DELTA, ["thread", "share", tid, "--visibility", "organization"]);
  if (r.rc !== 0) {
    console.error(`delta.bridge: thread share failed (append will refuse): ${r.stderr.trim()}`);
  }
  const now = new Date().toISOString();
  writeEnvFile(bindingFile(), { THREAD_ID: tid, LAST_SHARED_AT: now });
  return tid;
}
