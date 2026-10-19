// delta.bridge finalize — land a reviewed round on the real repository.
//
// Modes:
//   direct     commit the project working tree's uncommitted changes on the
//              current branch and push.
//   pr-squash  create a branch, commit, push, open a PR, and squash-merge it.
//
// The round to finalize is the one dispatch recorded in the plugin state.
// --mode/--merge overrides the remembered mode; --message overrides the
// commit message.

import fs from "node:fs";
import { run, finalizeFile, readEnvFile, die } from "../common.mjs";

let argMode = "";
let msg = "";
const args = process.argv.slice(2);
while (args.length > 0) {
  const a = args.shift();
  if (a === "--mode" || a === "--merge") argMode = args.shift();
  else if (a === "--message") msg = args.shift();
  else die(`unknown argument: ${a}`);
}

const ff = finalizeFile();
if (!fs.existsSync(ff)) {
  die("no finalized round recorded for this workspace; run dispatch first");
}
const rec = readEnvFile(ff);
const projectDir = rec.get("PROJECT_DIR");
const mergeTid = rec.get("THREAD_ID") ?? "";
if (!projectDir) die("finalize record has no PROJECT_DIR");

// Precedence: explicit --mode/--merge > the mode dispatch recorded > direct.
const mode = argMode || rec.get("MERGE") || "direct";
if (mode !== "direct" && mode !== "pr-squash") die("mode must be direct or pr-squash");

const dirty = run("git", ["-C", projectDir, "status", "--porcelain"]);
if (!dirty.stdout.trim()) die(`no uncommitted changes in ${projectDir} to land`);

msg = msg || `delta.bridge: land round ${mergeTid || "<unknown thread>"}`;
run("git", ["-C", projectDir, "add", "-A"]);

const git = (a) => {
  const r = run("git", ["-C", projectDir, ...a]);
  if (r.rc !== 0) die(`git ${a[0]} failed: ${r.stderr.trim() || `rc=${r.rc}`}`);
  return r.stdout;
};

if (mode === "direct") {
  git(["commit", "-m", msg]);
  const push = run("git", ["-C", projectDir, "push"]);
  if (push.rc !== 0) console.error("delta.bridge: push failed; push manually");
  console.log(`committed and pushed to the current branch in ${projectDir}`);
} else {
  const branch = `delta-bridge/${new Date().toISOString().replace(/[-:]/g, "").replace(/[T.]/g, "-").slice(0, 15)}`;
  git(["checkout", "-b", branch]);
  git(["commit", "-m", msg]);
  const push = run("git", ["-C", projectDir, "push", "-u", "origin", branch]);
  if (push.rc !== 0) die(`push of ${branch} failed`);
  const pr = run("gh", ["pr", "create", "--title", msg,
    "--body", `Landed from Delta thread ${mergeTid} via herdr-delta.`,
    "--head", branch], { cwd: projectDir });
  if (pr.rc !== 0) die("gh pr create failed (is gh authenticated?)");
  const merge = run("gh", ["pr", "merge", branch, "--squash", "--delete-branch"], { cwd: projectDir });
  if (merge.rc !== 0) {
    die(`gh pr merge --squash failed; finish the PR manually: ${pr.stdout.trim()}`);
  }
  console.log(`squash-merged ${branch} into the default branch (pr: ${pr.stdout.trim()})`);
}
