// delta.bridge — single entry point: cli.mjs <action> [args...]
// herdr-plugin.toml points every action here with the action id as argv[2].

import { die } from "./common.mjs";

const ACTIONS = ["open", "mount", "unmount", "sync", "archive", "dispatch", "finalize"];
const USAGE = `usage: cli.mjs <${ACTIONS.join("|")}> [args...]

dev/testing extras:
  cli.mjs daemon        run the startup daemon in the foreground
  cli.mjs bridge-loop   run one bridge loop (needs BRIDGE_* env; internal)`;

const action = process.argv[2];

switch (action) {
  case undefined:
    die(USAGE);
  case "daemon":
    await import("./daemon.mjs");
    break;
  case "bridge-loop":
    await import("./bridge-loop.mjs");
    break;
  default:
    if (!ACTIONS.includes(action)) die(`unknown action: ${action}\n${USAGE}`);
    // Actions read their own argv (they ran as the main script before).
    process.argv = [process.argv[1], ...process.argv.slice(2)];
    await import(`./actions/${action}.mjs`);
    break;
}
