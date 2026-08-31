#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const command = args[0];
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modules = {
  serve: "src/broker.mjs",
  list: "src/client.mjs",
  prompt: "src/client.mjs",
  interrupt: "src/client.mjs",
  compact: "src/client.mjs",
  mcp: "src/mcp-server.mjs",
  "tmux-cleanup": "scripts/tmux-cleanup.mjs",
  dashboard: "scripts/tmux-dashboard.mjs",
};

function usage() {
  process.stderr.write(
    "usage: pi-broker.mjs serve <socket> | list <socket> | prompt <socket> <session> <text> | interrupt <socket> <session> | compact <socket> <session> [instructions] | mcp [socket] | tmux-cleanup [socket] | dashboard [dashboardSessionName] [--attach]\n",
  );
  process.exitCode = 2;
}

if (!modules[command]) usage();
else {
  const rest = args.slice(1);
  const valid =
    // `mcp` alone is legal: the adapter then uses the deterministic default
    // socket and starts the broker there itself. `tmux-cleanup` follows the
    // same shape — an optional single positional argument (a socket), or
    // none at all. `dashboard` takes the same optional positional (a
    // dashboard session name) plus an optional `--attach` flag, in either
    // order, so up to two args.
    command === "mcp" || command === "tmux-cleanup"
      ? rest.length <= 1
      : command === "dashboard"
        ? rest.length <= 2
      : command === "serve" || command === "list"
        ? rest.length === 1
        : command === "prompt"
          ? rest.length >= 3
          : // compact takes <socket> <session> plus optional trailing custom
            // instructions for the summary.
            command === "compact"
            ? rest.length >= 2
            : rest.length === 2;
  if (!valid) usage();
  else {
    const moduleArgs =
      command === "serve" || command === "mcp" || command === "tmux-cleanup" || command === "dashboard"
        ? rest
        : [rest[0], command, ...rest.slice(1)];
    const child = spawn(
      process.execPath,
      [path.join(root, modules[command]), ...moduleArgs],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", () => forward("SIGINT"));
    process.on("SIGTERM", () => forward("SIGTERM"));
    child.on("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1);
    });
  }
}
