#!/usr/bin/env node
// Poll the broker's session list until every expected session has actually
// registered, or a timeout elapses.
//
// Why this exists: opening a terminal window is not the same as a Pi session
// registering with the broker. On macOS, `osascript` can exit 0 — no syntax
// error, no thrown AppleScript error — while Terminal.app never actually
// creates a window (GUI session unreachable, `do script` swallowed, etc.).
// quickstart.sh used to trust that exit code alone and print "quickstart is
// up" regardless of whether anything registered. This script is the missing
// check: it asks the broker itself, which only knows about a session once
// that session's own Pi process has connected and registered.
//
// Usage: node wait-for-sessions.mjs <socket> <timeout-ms> <session>...
// Exits 0 once every named session is present in `list`. Exits 1 and prints
// the still-missing sessions on stderr if the timeout elapses first.

import net from "node:net";

const [socketPath, timeoutMsArg, ...expected] = process.argv.slice(2);
if (!socketPath || !timeoutMsArg || expected.length === 0) {
  process.stderr.write(
    "usage: wait-for-sessions.mjs <socket> <timeout-ms> <session>...\n",
  );
  process.exit(2);
}
const timeoutMs = Number(timeoutMsArg);

function listOnce() {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const done = (sessions) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(sessions);
    };
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ type: "register", role: "controller" })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n");
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "registered") {
          socket.write(`${JSON.stringify({ type: "list", id: "wait-for-sessions" })}\n`);
        } else if (message.type === "response" && message.id === "wait-for-sessions") {
          // The broker wraps every reply as {type: "response", id, ...fields}
          // (src/protocol.mjs responseMessage) — it does not echo the request's
          // own `type` back, so matching on `id` alone is what src/client.mjs
          // does too. An earlier version of this file matched on
          // `type === "list"` instead, which never arrives and silently
          // burned the whole timeout every time — exactly the kind of "ran
          // with no error, did nothing" failure this script exists to catch.
          done(message.sessions || []);
        }
      }
    });
    // A broker that isn't listening yet, or a socket mid-teardown, is just
    // another "not registered yet" tick, not a fatal error.
    socket.on("error", () => done([]));
  });
}

const deadline = Date.now() + timeoutMs;
let missing = expected;
while (Date.now() < deadline) {
  const sessions = await listOnce();
  missing = expected.filter((id) => !sessions.includes(id));
  if (missing.length === 0) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

process.stderr.write(
  `wait-for-sessions: timed out after ${timeoutMs}ms; never registered: ${missing.join(", ")}\n`,
);
process.exit(1);
