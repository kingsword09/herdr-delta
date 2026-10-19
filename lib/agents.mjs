// Headless terminal-agent executors for the dispatch terminal engine.
// One agent = one case building an argv array; no shell word-splitting.

import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { die, haveBinary } from "./common.mjs";

// buildAgentArgs returns { bin, args } or throws.
export function buildAgentArgs({ agent = "codex", model = "", effort = "", task }) {
  switch (agent) {
    case "codex":
      return {
        bin: "codex",
        args: [
          "exec",
          "--json", // structured events, mapped onto Delta items
          ...(model ? ["-m", model] : []),
          ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []),
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
          task,
        ],
      };
    case "claude":
      return {
        bin: "claude",
        args: [
          "-p",
          ...(model ? ["--model", model] : []),
          "--dangerously-skip-permissions",
          "--output-format", "stream-json", "--verbose",
          task,
        ],
      };
    case "zcode": {
      // ZCode headless: --prompt long form (short -p is ambiguous in
      // 0.16.9); yolo mode so it lands changes. No usable JSON event
      // stream in 0.16.9, so dispatch falls back to the narrative filter.
      const bin = process.env.ZCODE_BIN ?? "zcode";
      return { bin, args: ["--prompt", task, "--mode", "yolo", "--surface", "terminal"] };
    }
    default:
      throw new Error(`no headless template for agent '${agent}'`);
  }
}

// Run the agent inside <checkout>, streaming combined output to <logFile>
// and, when onLine is given, each stdout line to it as it arrives (used to
// translate structured events into Delta items live).
export function runTerminalAgent({ agent, model, effort, task, checkout, logFile, onLine }) {
  let spec;
  try {
    spec = buildAgentArgs({ agent, model, effort, task });
  } catch (e) {
    fs.writeFileSync(logFile, `delta.bridge: ${e.message}\n`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile, { flags: "w" });
    const child = spawn(spec.bin, spec.args, {
      cwd: checkout,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const finish = (rc) => {
      if (settled) return;
      settled = true;
      out.end(() => resolve(rc));
    };
    if (onLine) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        out.write(`${line}\n`);
        try {
          onLine(line);
        } catch { /* a mapping error must not kill the run */ }
      });
    } else {
      child.stdout.pipe(out, { end: false });
    }
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => {
      out.write(`delta.bridge: cannot run ${spec.bin}: ${e.message}\n`);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

// The caller resolves availability via haveBinary before dispatch so a
// missing agent binary cannot silently produce an empty log.
export function checkAgentAvailable(agent) {
  const spec = buildAgentArgs({ agent, task: "check" });
  if (!haveBinary(spec.bin)) {
    die(`${agent} agent binary '${spec.bin}' not found on PATH` +
      (agent === "zcode" ? "; set ZCODE_BIN (e.g. the npx bin path)" : ""));
  }
}
