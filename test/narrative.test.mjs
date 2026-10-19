// Unit tests for agent-narrative: noise stripping + tool_call inference.

import assert from "node:assert/strict";

const { narrative, inferToolCalls } = await import("../lib/agent-narrative.mjs");

// --- test 1: node stack traces / hub dumps / noise are dropped ----------
{
  const raw = [
    "ZCode Built-in skipped (not-due)",
    "APICallError [AI_APICallError]: Bad Gateway",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
    "  requestBodyValues: {",
    "    tools: [",
    "      [Object], [Object], [Object],",
    "      ... 171 more items",
    "  statusCode: 502,",
    "────────────────────────────────",
    "Created `BRIDGE_E2E.md` in the repo root containing the single line `herdr-delta dispatch e2e ok`.",
  ].join("\n");
  const out = narrative(raw);
  assert.ok(!out.includes("[Object]"), "no util.inspect noise");
  assert.ok(!out.includes("APICallError"), "no error dumps");
  assert.ok(!out.includes("at process"), "no stack frames");
  assert.ok(out.includes("Created `BRIDGE_E2E.md`"), "the useful line survives");
  console.log("ok 1 - narrative drops node/hub noise, keeps prose");
}

// --- test 2: tool-call inference ----------------------------------------
{
  const narr = "Planned the change.\nCreated `PR_SQUASH_E2E.md` with a line.\nRan the full test suite.";
  const cards = inferToolCalls(narr, "herdr-w4-task-1");
  assert.equal(cards.length, 2);
  assert.equal(cards[0].kind, "edit");
  assert.ok(cards[0].title.includes("PR_SQUASH_E2E"), "file name captured");
  assert.equal(cards[1].kind, "execute");
  assert.equal(cards[1].status, "completed");
  assert.ok(cards[0].toolCallId.startsWith("herdr-w4-task-1/"));
  console.log("ok 2 - tool cards inferred from Created/Ran lines");
}

// --- test 3: dedup + cap at 3 cards -------------------------------------
{
  const narr = Array.from({ length: 6 }, (_, i) => `Created \`file${i}.md\` just now`).join("\n");
  const cards = inferToolCalls(narr, "x");
  assert.equal(cards.length, 3, "capped at 3");
  assert.equal(new Set(cards.map((c) => c.title)).size, 3, "titles deduped");
  console.log("ok 3 - cards deduped and capped");
}

// --- test 4: empty narrative falls back in recordAgentExecution ---------
{
  const { recordAgentExecution } = await import("../lib/agent-narrative.mjs");
  const calls = [];
  const fakeRec = {
    externalId: "s",
    toolCall: (c) => calls.push(["card", c]),
    message: (kind, id, text) => calls.push(["msg", kind, text]),
  };
  recordAgentExecution(fakeRec, { rawLog: "[Object], [Object]", summaryLine: "zcode ran" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "agent_message");
  assert.ok(calls[0][2].includes("[Object]"), "raw tail fallback when narrative is empty");
  console.log("ok 4 - empty narrative falls back to raw tail");
}

console.log("all narrative tests passed");
