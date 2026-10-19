// Unit tests for agent-events: codex --json and claude stream-json are
// translated into Delta's native items (agent_thought / tool_call_update /
// agent_message) instead of pasted terminal text.

import assert from "node:assert/strict";

const { EventMapper, eventMode } = await import("../lib/agent-events.mjs");

function collector() {
  const items = [];
  return {
    items,
    thought: (id, text) => items.push({ type: "thought", id, text }),
    toolCall: (c) => items.push({ type: "tool", ...c }),
    message: (k, id, text) => items.push({ type: "message", messageKind: k, id, text }),
  };
}

// --- test 1: mode selection --------------------------------------------
assert.equal(eventMode("codex"), "codex-json");
assert.equal(eventMode("claude"), "claude-stream");
assert.equal(eventMode("zcode"), "text");
console.log("ok 1 - event modes");

// --- test 2: codex stream -> thought + tool cards + final message ------
{
  const rec = collector();
  const m = new EventMapper(rec, "codex");
  const lines = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i1", type: "reasoning", text: "I should read the README first" } },
    { type: "item.completed", item: { id: "i2", type: "command_execution", command: "ls -la", status: "completed", aggregated_output: "a.txt" } },
    { type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "a.txt" }, { path: "b.txt" }], status: "completed" } },
    { type: "item.completed", item: { id: "i4", type: "agent_message", text: "Done: created a.txt" } },
    { type: "turn.completed" },
  ];
  for (const l of lines) m.feed(JSON.stringify(l));
  const res = m.finish();

  assert.equal(res.structured, true);
  const thoughts = rec.items.filter((i) => i.type === "thought");
  assert.equal(thoughts.length, 1, "reasoning became a thinking block");
  assert.match(thoughts[0].text, /README/);

  const tools = rec.items.filter((i) => i.type === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].title, "ls -la");
  assert.equal(tools[0].kind, "execute");
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[1].kind, "edit");
  assert.deepEqual(tools[1].locations, [{ path: "a.txt" }, { path: "b.txt" }]);

  const msgs = rec.items.filter((i) => i.type === "message");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].messageKind, "agent_message");
  assert.match(msgs[0].text, /^\[herdr\]: Done: created a\.txt/);
  console.log("ok 2 - codex items mapped (thought + execute/edit cards + final)");
}

// --- test 3: claude stream-json -> thinking + tool_use/result pairs ----
{
  const rec = collector();
  const m = new EventMapper(rec, "claude");
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [
      { type: "thinking", thinking: "Let me check the file" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/tmp/a.txt" } },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu1", content: "hello" },
    ] } },
    { type: "assistant", message: { content: [
      { type: "tool_use", id: "tu2", name: "Bash", input: { command: "npm test" } },
    ] } },
    { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true },
    ] } },
    { type: "assistant", message: { content: [{ type: "text", text: "The file says hello." }] } },
    { type: "result", subtype: "success", result: "The file says hello.", is_error: false },
  ];
  for (const l of lines) m.feed(JSON.stringify(l));
  const res = m.finish();

  assert.equal(res.structured, true);
  const thoughts = rec.items.filter((i) => i.type === "thought");
  assert.equal(thoughts.length, 1);

  const tools = rec.items.filter((i) => i.type === "tool");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].toolCallId, "tu1");
  assert.equal(tools[0].kind, "read");
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[0].text, "hello");
  assert.equal(tools[1].kind, "execute");
  assert.equal(tools[1].status, "failed", "is_error maps to failed");
  assert.equal(tools[1].title, "npm test");

  const msgs = rec.items.filter((i) => i.type === "message");
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].text, /The file says hello/);
  console.log("ok 3 - claude tool_use/tool_result paired into cards");
}

// --- test 4: text mode uses the narrative filter ----------------------
{
  const rec = collector();
  const m = new EventMapper(rec, "zcode");
  m.feed("ZCode Built-in skipped (not-due)");
  m.feed("    at process.processTicksAndRejections (node:internal/x:1:1)");
  m.feed("Created `X.md` in the repo root.");
  const res = m.finish();
  assert.equal(res.structured, false);
  assert.equal(res.text, "Created `X.md` in the repo root.");
  const msgs = rec.items.filter((i) => i.type === "message");
  assert.equal(msgs.length, 1);
  assert.ok(!msgs[0].text.includes("at process"), "stack noise stripped");
  console.log("ok 4 - text mode strips terminal noise");
}

// --- test 5: non-JSON stdout in a structured mode is ignored ----------
{
  const rec = collector();
  const m = new EventMapper(rec, "codex");
  m.feed("Reading additional input from stdin...");
  m.feed(JSON.stringify({ type: "item.completed", item: { id: "x", type: "agent_message", text: "ok" } }));
  const res = m.finish();
  assert.equal(res.structured, true);
  assert.equal(res.text, "ok");
  console.log("ok 5 - non-JSON lines ignored in structured mode");
}

console.log("all event tests passed");
