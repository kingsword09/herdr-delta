// Turn a headless terminal agent's raw log into Delta-native content:
// a short agent_message summary plus tool_call_update cards (first-class
// items in the Delta UI, unlike pasted terminal text).
//
// The append contract (probed on Delta 0.20.1):
//   tool_call_update: {sessionUpdate, toolCallId, title?, kind?, status?,
//                      content?: [{type:"content", content: {type:"text",
//                      text}}...], locations?: [{path, line?}...],
//                      rawInput?, rawOutput?} — all fields optional except
//                      toolCallId; kind: read|edit|execute|search|fetch|...,
//                      status: pending|in_progress|completed|failed|cancelled
//   agent_thought / plan_update / terminal_update: rejected by recording
//   (plan_update's wire shape could not be matched across many probes).

import { Recorder } from "./delta.mjs";

// Lines worth showing: prose an agent actually said or did. Drops node
// stack traces, util.inspect dumps ([Object]/[Array] noise), hub/proxy
// retry spam, HTTP header echoes, and status-bar artifacts.
const NOISE = [
  /\[Object\]|\[Array\]/,
  /^\s+at\s+/,
  /^APICallError\b/,
  /^\s*(cause|url|requestBodyValues|statusCode|responseHeaders|responseBody|isRetryable|data:|metadata:|user_id:|model:|max_tokens|temperature|top_k|top_p|stop_sequences|system:|messages:|tools:|tool_choice|stream:)\b/,
  /^\s*[}\],]\s*$|^\s*[}\],]/,
  /^\s*\.\.\.\s+\d+\s+more items/,
  /^ZCode Built-in skipped/,
  /^\s*(connection|content-length|content-type|date|keep-alive):\s/,
  /^Symbol\(/,
  /^─+$/,
  /^\s*$/,
];

function isNoise(line) {
  const t = line.trim();
  // util.inspect continuations: `key: '...'` or `key: {` deep-indented
  if (/^[\w'"$.-]+:\s/.test(t) && /^\s{2,}/.test(line)) return true;
  if (/^Symbol\(/.test(t)) return true;
  return NOISE.some((re) => re.test(line));
}

// Extract a compact narrative from a raw agent log.
export function narrative(rawLog) {
  const lines = String(rawLog).split("\n");
  const kept = [];
  for (const line of lines) {
    if (isNoise(line)) continue;
    kept.push(line.replace(/\s+$/, ""));
  }
  return kept.join("\n").trim();
}

// Recognized agent actions worth a tool_call card. One regex per kind;
// captures: 1=title-ish description, optional extras.
const TOOL_HINTS = [
  // "Created `X`" / "Wrote X" / "Edited X"
  { re: /\b(?:Created|Wrote|Edited|Modified|Deleted|Removed)\s+`?([^`\n]+?)`?\b/i, kind: "edit" },
  // "ran tests" / "executed X"
  { re: /\b(?:Ran|Executed)\s+(.+)/i, kind: "execute" },
  // explicit file paths mentioned as changed
  { re: /\b(?:in|to)\s+(?:the\s+)?(?:file\s+)?`?((?:lib|src|bin|test)\/[\w./-]+|[\w-]+\.(?:mjs|js|ts|md|sh|py))`?/i, kind: "edit" },
];

// Derive 0-3 tool_call cards from the narrative lines.
export function inferToolCalls(narrText, toolCallIdBase) {
  const cards = [];
  const seenTitles = new Set();
  for (const line of narrText.split("\n")) {
    for (const hint of TOOL_HINTS) {
      const m = line.match(hint.re);
      if (!m) continue;
      const title = m[1].trim().replace(/[.,;:]$/, "");
      if (!title || title.length > 80 || seenTitles.has(title)) continue;
      seenTitles.add(title);
      cards.push({
        toolCallId: `${toolCallIdBase}/${cards.length + 1}`,
        title,
        kind: hint.kind,
        status: "completed",
      });
      if (cards.length >= 3) return cards;
    }
  }
  return cards;
}

// Record one terminal-agent execution as Delta-native content: tool_call
// cards for the inferred actions, then an agent_message with the narrative
// (fallback: raw tail, so failures like 502s still show up).
export function recordAgentExecution(rec, { rawLog, summaryLine }) {
  const cards = inferToolCalls(narrative(rawLog), rec.externalId);
  for (const card of cards) {
    rec.toolCall(card);
  }
  const body = narrative(rawLog) || String(rawLog).slice(-2000).trim();
  rec.message("agent_message", "exec",
    `[herdr]: ${summaryLine}\n\n${body}`.slice(0, 8000));
}
