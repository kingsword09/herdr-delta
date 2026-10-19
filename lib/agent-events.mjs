// Map agent event streams onto Delta's native recording items.
//
// Why: pasting an agent's terminal output into an agent_message renders as
// a wall of text in Delta. Native Delta threads instead record each step —
// reasoning as agent_thought, each tool as tool_call_update — and the UI
// aggregates them into "Thought 8 times, listed 5 directories, read 16
// files". This module performs that translation.
//
// Supported streams (probed against the installed CLIs):
//   codex --json            thread.started / turn.started / item.completed /
//                           turn.completed / error; item.type is one of
//                           agent_message, reasoning, command_execution,
//                           file_change, mcp_tool_call, web_search, todo_list
//   claude --output-format stream-json --verbose
//                           system(init) / assistant{content:[text,
//                           tool_use, thinking]} / user{tool_result} / result
//   text                    anything else (zcode): narrative fallback

import { narrative } from "./agent-narrative.mjs";

// Claude tool name -> Delta tool kind.
const CLAUDE_KINDS = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
  BashOutput: "execute",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "other",
};

// Codex item type -> Delta tool kind.
const CODEX_KINDS = {
  command_execution: "execute",
  file_change: "edit",
  mcp_tool_call: "other",
  web_search: "fetch",
};

function short(text, max = 400) {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Per-agent event mode.
export function eventMode(agent) {
  if (agent === "codex") return "codex-json";
  if (agent === "claude") return "claude-stream";
  return "text";
}

// Incremental mapper: feed() each stdout line, finish() once at the end.
// Emits through the Recorder so every item lands in the recorded turn.
export class EventMapper {
  constructor(rec, agent) {
    this.rec = rec;
    this.mode = eventMode(agent);
    this.seq = 0;
    this.rawLines = [];          // text-mode fallback
    this.pendingTools = new Map(); // claude tool_use id -> {title, kind, input}
    this.finalText = "";         // codex agent_message / claude result
    this.sawStructured = false;
  }

  nextId(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  feed(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.rawLines.push(line);
    if (this.mode === "text") return;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return; // non-JSON chatter on stdout is not an event
    }
    this.sawStructured = true;
    if (this.mode === "codex-json") this.feedCodex(ev);
    else if (this.mode === "claude-stream") this.feedClaude(ev);
  }

  // ---------- codex --json ----------
  feedCodex(ev) {
    if (ev.type === "item.completed" && ev.item) {
      const it = ev.item;
      switch (it.type) {
        case "reasoning": {
          const text = it.text ?? it.summary ?? "";
          if (text) this.rec.thought(this.nextId("t"), short(text, 1200));
          break;
        }
        case "agent_message":
          if (it.text) this.finalText = it.text;
          break;
        case "command_execution": {
          const cmd = it.command ?? "";
          this.rec.toolCall({
            toolCallId: it.id ?? this.nextId("tc"),
            title: short(cmd, 100) || "command",
            kind: "execute",
            status: it.status === "failed" ? "failed" : "completed",
            text: short(it.aggregated_output ?? it.output ?? ""),
            rawInput: cmd,
          });
          break;
        }
        case "file_change": {
          const paths = (it.changes ?? []).map((c) => c.path).filter(Boolean);
          this.rec.toolCall({
            toolCallId: it.id ?? this.nextId("tc"),
            title: paths.join(", ") || "file change",
            kind: "edit",
            status: it.status === "failed" ? "failed" : "completed",
            locations: paths.map((p) => ({ path: p })),
          });
          break;
        }
        case "mcp_tool_call":
          this.rec.toolCall({
            toolCallId: it.id ?? this.nextId("tc"),
            title: `${it.server ?? "mcp"}/${it.tool ?? "call"}`,
            kind: "other",
            status: it.status === "failed" ? "failed" : "completed",
            text: short(typeof it.result === "string" ? it.result : JSON.stringify(it.result ?? "")),
          });
          break;
        case "web_search":
          this.rec.toolCall({
            toolCallId: it.id ?? this.nextId("tc"),
            title: short(it.query ?? "web search", 100),
            kind: "fetch",
            status: "completed",
          });
          break;
        case "todo_list":
          break; // no faithful Delta equivalent; the plan is visible in text
        case "error":
          break; // surfaced through turn.failed / final message
        default:
          break;
      }
      return;
    }
    if (ev.type === "turn.failed" || ev.type === "error") {
      const msg = ev.message ?? ev.error?.message ?? "";
      if (msg) this.errors = [...(this.errors ?? []), short(msg)];
    }
  }

  // ---------- claude stream-json ----------
  feedClaude(ev) {
    if (ev.type === "assistant" && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type === "thinking" && b.thinking) {
          this.rec.thought(this.nextId("t"), short(b.thinking, 1200));
        } else if (b.type === "text" && b.text) {
          this.finalText = b.text;
        } else if (b.type === "tool_use") {
          this.pendingTools.set(b.id, {
            title: this.claudeTitle(b),
            kind: CLAUDE_KINDS[b.name] ?? "other",
            input: b.input,
          });
        }
      }
      return;
    }
    if (ev.type === "user" && ev.message?.content) {
      for (const b of ev.message.content) {
        if (b.type !== "tool_result") continue;
        const pending = this.pendingTools.get(b.tool_use_id);
        if (!pending) continue;
        this.pendingTools.delete(b.tool_use_id);
        const out = typeof b.content === "string"
          ? b.content
          : (b.content ?? []).map((c) => c.text ?? "").join("\n");
        this.rec.toolCall({
          toolCallId: b.tool_use_id,
          title: pending.title,
          kind: pending.kind,
          status: b.is_error ? "failed" : "completed",
          text: short(out, 2000),
          rawInput: JSON.stringify(pending.input ?? {}),
        });
      }
      return;
    }
    if (ev.type === "result") {
      if (typeof ev.result === "string" && ev.result) this.finalText = ev.result;
      if (ev.is_error) this.errors = [...(this.errors ?? []), short(ev.result)];
    }
  }

  claudeTitle(block) {
    const i = block.input ?? {};
    switch (block.name) {
      case "Read": return short(i.file_path ?? "read", 100);
      case "Write": return short(i.file_path ?? "write", 100);
      case "Edit": return short(i.file_path ?? "edit", 100);
      case "MultiEdit": return short(i.file_path ?? "edit", 100);
      case "Bash": return short(i.command ?? "bash", 100);
      case "Grep": return short(i.pattern ?? "grep", 100);
      case "Glob": return short(i.pattern ?? "glob", 100);
      case "WebFetch": return short(i.url ?? "fetch", 100);
      case "WebSearch": return short(i.query ?? "search", 100);
      default: return short(block.name ?? "tool", 100);
    }
  }

  // Flush at end of run: unresolved tools, then the final answer.
  // rawLog is used only in text mode (agents whose output is not JSON, and
  // whose useful text may have gone to stderr).
  finish(rawLog = "") {
    for (const [id, p] of this.pendingTools) {
      this.rec.toolCall({
        toolCallId: id,
        title: p.title,
        kind: p.kind,
        status: "completed",
        rawInput: JSON.stringify(p.input ?? {}),
      });
    }
    this.pendingTools.clear();

    const body = this.mode === "text"
      ? narrative(rawLog || this.rawLines.join("\n"))
      : this.finalText.trim();

    const errors = (this.errors ?? []).join("\n");
    const text = [body, errors].filter(Boolean).join("\n\n");
    if (text) {
      this.rec.message("agent_message", "final", `[herdr]: ${text}`.slice(0, 8000));
    }
    return { structured: this.sawStructured, text };
  }
}
