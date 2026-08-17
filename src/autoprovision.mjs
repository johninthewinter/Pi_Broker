// On-demand provisioning for the MCP adapter.
//
// Goal: any MCP-speaking client can point at the adapter and start calling
// tools without anyone having run `npm run quickstart` first.
//
// Nothing here knows or asks which client is connected. Provisioning is
// triggered purely by state — "a tool call arrived and no broker/session
// exists yet" — so it fires identically for Claude Code, Codex, OpenCode,
// Hermes, a bare SDK client, or anything that shows up later. There is no
// client identification and no per-host branch anywhere on this path.
//
// Two separate, independently idempotent steps:
//   ensureBroker()  — cheap, safe, run once at MCP-server startup.
//   ensureSession() — opens a real Terminal.app window, so it runs lazily, only
//                     when a tool call actually names a session that is not
//                     registered yet.
//
// Non-negotiable: what gets started is the same ordinary interactive `pi` TUI
// a human would launch by hand, in a window that human can see and type into.
// There is no headless fallback anywhere in this file — if a visible window
// cannot be opened, this fails with an honest error instead.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  SESSION_ID_PATTERN,
  assertSessionId,
  detectTerminal,
  noTerminalMessage,
} from "../scripts/open-pi-windows.mjs";

// Re-exported so the MCP layer validates `target` against the *same* rule the
// window opener enforces, rather than a second copy that can drift from it.
export { SESSION_ID_PATTERN, assertSessionId };

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A unix socket path is capped at 104 bytes, so this stays short and outside
// $TMPDIR (macOS per-user temp paths are already ~49 characters).
const DEFAULT_RUNTIME_DIR = `/tmp/pi-broker-${process.getuid?.() ?? 0}`;

const BROKER_START_TIMEOUT_MS = 10_000;
const BROKER_LOCK_TIMEOUT_MS = 20_000;
// Deliberately under the MCP SDK's 60s default per-request timeout: a cold Pi
// boot that overruns should surface as our own actionable message ("the window
// is open, Pi is still starting, call again"), not as an opaque host timeout.
const SESSION_TIMEOUT_MS = Number(
  process.env.PI_BROKER_SESSION_TIMEOUT_MS ?? 45_000,
);

export function autoprovisionEnabled() {
  const value = process.env.PI_BROKER_AUTOPROVISION;
  return value !== "0" && value !== "false";
}

export function runtimeDir() {
  return process.env.PI_BROKER_RUNTIME_DIR || DEFAULT_RUNTIME_DIR;
}

/**
 * The socket every entry point agrees on when the operator did not name one.
 * Deterministic on purpose: a second `pi-broker mcp` invocation, or the same
 * host reconnecting, must land on the *same* broker rather than starting a
 * fresh one and stranding the sessions registered with the first.
 */
export function defaultSocketPath() {
  return (
    process.env.PI_BROKER_SOCKET || path.join(runtimeDir(), "broker.sock")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when something is listening on the socket right now. */
export function brokerIsListening(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Session ids the broker currently has registered. */
export function listSessions(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const fail = (error) => {
      socket.removeAllListeners();
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5000, () => fail(new Error("broker list timed out")));
    socket.once("error", fail);
    socket.once("connect", () =>
      socket.write('{"type":"register","role":"controller"}\n'),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const split = buffer.indexOf("\n");
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.type === "registered") {
          socket.write('{"type":"list","id":"autoprovision"}\n');
          continue;
        }
        if (message.id === "autoprovision" && message.sessions) {
          socket.removeAllListeners();
          socket.destroy();
          resolve(message.sessions);
          return;
        }
      }
    });
  });
}

/**
 * Take a coarse cross-process lock by atomically creating a directory.
 * Two MCP adapters starting at the same moment must not both spawn a broker,
 * and neither may hang forever on a lock left behind by a killed process.
 */
async function withLock(lockPath, staleMs, fn) {
  const deadline = Date.now() + staleMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // holder released it between the mkdir and the stat
      }
      if (age > staleMs) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`lock is stuck: ${lockPath}`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Make sure a broker owns `socketPath`, starting one if not.
 * Idempotent and cheap: an already-running broker is reused, never duplicated,
 * so a host's second (or fifth) MCP connection attaches to the first broker
 * and sees the sessions already registered with it.
 */
export async function ensureBroker(socketPath) {
  if (await brokerIsListening(socketPath)) return { started: false, socketPath };

  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  return withLock(`${socketPath}.lock`, BROKER_LOCK_TIMEOUT_MS, async () => {
    // Another adapter may have won the race while we waited for the lock.
    if (await brokerIsListening(socketPath))
      return { started: false, socketPath };

    // A socket file with nobody behind it is a corpse from a killed broker;
    // src/broker.mjs refuses to replace an existing path, so clear it first.
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

    const logPath = path.join(dir, "broker.log");
    const log = fs.openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [path.join(root, "src", "broker.mjs"), socketPath],
      { cwd: root, detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
    fs.closeSync(log);

    const deadline = Date.now() + BROKER_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await brokerIsListening(socketPath))
        return { started: true, socketPath, pid: child.pid, logPath };
      await sleep(100);
    }
    throw new Error(
      `pi-broker: auto-started broker never listened on ${socketPath}; see ${logPath}`,
    );
  });
}

/**
 * Can this machine put a real terminal window on the screen at all?
 *
 * Platform-specific, and answered by the one shared opener module so this file
 * and the opener can never disagree: macOS needs osascript, Linux/BSD needs a
 * graphical display plus a terminal emulator, Windows needs wt.exe, cmd.exe,
 * or PowerShell. `PI_SESSION_OPEN` (test seam) short-circuits all of it.
 */
function windowSupport() {
  return detectTerminal();
}

/**
 * Make sure `sessionId` is a live, registered, *visible* interactive Pi.
 * Returns { opened: false } when it was already there — provisioning must never
 * stack a second window on a session a previous connection already created.
 */
export async function ensureSession(socketPath, sessionId) {
  // Defence in depth: the MCP layer validates `target` with the same rule, but
  // this function is also reachable directly (tests, future callers), and the
  // id it is given ends up as a filename, a window title, and text inside a
  // generated launch script.
  assertSessionId(sessionId);

  if ((await listSessions(socketPath)).includes(sessionId))
    return { opened: false, sessionId };

  const terminal = windowSupport();
  if (terminal.kind === null) {
    throw new Error(
      noTerminalMessage({
        reason: terminal.reason,
        socket: socketPath,
        session: sessionId,
      }),
    );
  }

  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  return withLock(
    path.join(dir, `session-${sessionId}.lock`),
    SESSION_TIMEOUT_MS,
    async () => {
      if ((await listSessions(socketPath)).includes(sessionId))
        return { opened: false, sessionId };

      // Node, not bash: bash is not a given on Windows, and this is the only
      // implementation of "open a visible window" in the repository.
      await execFileAsync(
        process.execPath,
        [
          path.join(root, "scripts", "open-pi-windows.mjs"),
          root,
          dir,
          socketPath,
          sessionId,
        ],
        { cwd: root, timeout: 30_000 },
      );

      const deadline = Date.now() + SESSION_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await listSessions(socketPath)).includes(sessionId))
          return { opened: true, sessionId };
        await sleep(250);
      }
      throw new Error(
        `pi-broker: opened a terminal window for '${sessionId}', but it has not ` +
          `registered within ${Math.round(SESSION_TIMEOUT_MS / 1000)}s. Pi is ` +
          "probably still starting — look at the window titled " +
          `"pi-broker ${sessionId}" and call again.`,
      );
    },
  );
}
