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
