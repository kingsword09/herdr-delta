# herdr-delta

[herdr](https://herdr.dev) plugin that bridges herdr agents and
[Delta](https://delta.dev) threads. Zero patches on either side — it is
built entirely on Delta's official external-owner CLI contract
(`delta thread create/share/append/watch/mount`) and herdr's plugin API.

## Actions

| Action | What it does |
| --- | --- |
| `delta.bridge.open` | Open or create the Delta thread bound to the current herdr workspace (attaching the workspace's project), and focus it in the Delta app. Also handles clicked `delta.dev/join/...` links. |
| `delta.bridge.mount` | Keep the bound thread's worktrees mounted so pane agents can work on the thread's checkout. Lives as long as the herdr server. |
| `delta.bridge.unmount` | Release the mounts once the agents' changes are uploaded. |
| `delta.bridge.sync` | Bind the invoking pane's agent to the thread and arm the live message bridge. |
| `delta.bridge.archive` | Snapshot the pane's recent output into the thread so the session is searchable from Delta. |
| `delta.bridge.dispatch` | Run one full round through a Delta checkout. `--engine terminal` executes a headless agent (`--agent codex\|claude\|zcode`, `--model`, `--effort`) inside the mounted checkout; `--engine delta` records the task and waits for a Send in the GUI. `--merge direct\|pr-squash` is remembered for finalize; `--reviewer PANE` gets nudged when the round ends. |
| `delta.bridge.finalize` | Land the reviewed round's uncommitted changes: `--mode direct` (commit + push) or `--mode pr-squash` (branch → PR → squash merge). Without `--mode`, the mode dispatch recorded is used. |

## The message bridge (sync)

After `delta.bridge.sync`, the plugin's startup daemon runs
`delta thread watch` for the bound thread:

1. You type a message in the Delta app starting with
   `[delta-bridge]: ` — e.g. `[delta-bridge]: fix the failing test`.
2. The bridge submits it to the bound pane's agent with
   `herdr agent prompt --wait`.
3. When the agent settles, the bridge records the turn back into the
   thread (user message, agent reply, running→idle state), so the Delta
   app shows the full exchange.

Only `[delta-bridge]: `-prefixed messages are relayed, so humans can talk
in the same thread without accidentally driving the agent.

## Triggering from an agent (zcode, codex, claude)

An agent running inside a herdr pane already has the context the plugin
needs (`HERDR_WORKSPACE_ID`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`), so the
shortest path is the launcher:

```sh
# from any pane / any agent shell
/path/to/herdr-delta/bin/delta-bridge dispatch \
  "fix the failing test in src/parser.ts" \
  --agent codex --model gpt-6-astra --effort high --merge direct
```

Put `bin/` on PATH once and drop the path:

```sh
export PATH="$HOME/Documents/code/ai/herdr-delta/bin:$PATH"
delta-bridge dispatch "add retry to the uploader" --agent zcode
```

A planning agent usually pipes the plan in instead of quoting it:

```sh
printf '%s' "$PLAN" | delta-bridge dispatch --agent codex --merge pr-squash
```

The other actions need no task and work the same way:

```sh
delta-bridge open                       # create/open this workspace's thread
delta-bridge sync                       # bind this pane's agent for live chat
delta-bridge archive                    # snapshot this pane into the thread
delta-bridge mount / unmount            # borrow / return a checkout manually
delta-bridge finalize --mode pr-squash  # land the reviewed round
```

From the herdr UI the same actions appear in the action menu
(workspace/pane context). The UI cannot pass a task string, so use the
launcher (or stdin) for `dispatch`.

`herdr plugin action invoke <action> --plugin delta.bridge` works for the
argument-less actions; herdr does not forward extra argv to plugin actions.

State lives in `~/.local/state/herdr/plugins/delta.bridge/` (bindings,
sequence counters, round records), which is the directory herdr injects as
`HERDR_PLUGIN_STATE_DIR`.

## Native rendering (dispatch)

Dispatch records a round as Delta-native items, so the thread renders like
a turn produced by Delta's own agent rather than a pasted terminal log:

- **Thinking** — `agent_thought` records (requires `messageId`; the
  recorder rejects thoughts without one).
- **Tools** — `tool_call_update` records with `title`, `kind`
  (`read`/`edit`/`execute`/`search`/`fetch`/`other`), `status`, content
  and locations. Delta aggregates them into a summary line such as
  `Thought 8 times, listed 5 directories, read 16 files`.
- **Answer** — one `agent_message` with the agent's final text.

Structured agent streams are translated event by event:

| Agent | Stream | Mapping |
| --- | --- | --- |
| `codex` | `codex exec --json` | `reasoning` → thought; `command_execution` / `file_change` / `mcp_tool_call` / `web_search` → tool cards; `agent_message` → final answer |
| `claude` | `claude -p --output-format stream-json --verbose` | `thinking` → thought; `tool_use` + `tool_result` paired into one card per call (`is_error` → failed); `result` → final answer |
| `zcode` | plain text (0.16.9 has no usable JSON event stream) | narrative filter strips stacks and `[Object]` dumps; falls back to the raw tail so failures stay visible |

`plan_update`, `terminal_update`, and `agent_thought` without a
`messageId` are rejected by Delta's recording path, so the mapper never
emits them.

## Install

The `delta` CLI must be on PATH **as a symlink** (a copy of the app binary
is killed by macOS code signing):

```sh
ln -sfn /Applications/Delta.app/Contents/MacOS/delta ~/.local/bin/delta
```

Local development:

```sh
git clone <this repo> && cd herdr-delta
herdr plugin link "$PWD"
```

From GitHub (after publishing):

```sh
herdr plugin install <owner>/herdr-delta
```

## Requirements

- Delta 0.20.1 or later (`delta thread` recording contract v1)
- herdr 0.9.0 or later
- Node.js >= 20 (or bun) — all plugin logic runs on it

## Tests

The reverse-engineered append contract has unit tests (fake `delta` binary
enforcing the real invariants):

```sh
node test/recorder.test.mjs
```

## Security note

Messages posted to a shared Delta thread that start with `[delta-bridge]: `
are relayed to a local agent, and terminal-engine agents run with
permissions bypassed. Since `--visibility organization` puts the thread on
Delta Cloud, anyone who can post to that thread can drive your local agent
with your credentials. Only bridge threads you trust, and prefer
`--engine delta` (human presses Send) for untrusted content.

## Notes and caveats

- `thread append` requires the thread to be shared with your organization
  (`--visibility organization`); the plugin does this automatically when it
  creates a binding. Archived pane output therefore goes to Delta Cloud —
  only bridge what you are comfortable sharing.
- Append sequences are contiguous per stream; the plugin keeps its
  counters under herdr's plugin state dir. Deleting Delta's local database
  invalidates them — run `herdr plugin config-dir delta.bridge` and clear
  the state dir if streams disagree.
- Delta 0.20.1 has no headless turn runner, so the agent you drive is a
  real terminal agent (claude/codex/…) in a herdr pane; Delta's own model
  turns run in the app as usual.
