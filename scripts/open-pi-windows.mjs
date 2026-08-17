#!/usr/bin/env node
// Open one real, visible terminal window per named session, each running an
// ordinary interactive `pi` TUI with the broker bridge extension loaded.
//
// This is the single implementation of "put a visible, joinable Pi session on
// the screen". Both entry points use it:
//   - scripts/quickstart.sh   (human runs it up front, N sessions) via the
//     scripts/open-pi-windows.sh shim, which only forwards to this file
//   - src/autoprovision.mjs   (MCP adapter provisions one on demand)
//
// It is written in Node, not bash + AppleScript, for one reason: Node is the
// only thing this project already requires on every platform. bash is not a
// given on Windows and AppleScript is macOS-only, so the previous shell
// implementation could physically never open a window anywhere but macOS.
//
// Usage: node scripts/open-pi-windows.mjs <root> <run-dir> <socket> <session>...
//
// Env overrides (test seams, and the reason there is no duplicate launcher
// logic anywhere else in the repo):
//   PI_SESSION_PI_COMMAND  command run inside each session window
//   PI_SESSION_OPEN        opener called as: <opener> <script-path> <title>
//
// No headless Pi (-p / --print / --mode) is used or permitted here. If a
// visible window cannot be opened, this exits non-zero with the exact manual
// command instead of degrading to a hidden session.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PI_COMMAND =
  "npm exec -- pi --extension ./extensions/pi-broker-bridge.ts";

/**
 * What a session id is allowed to be, everywhere.
 *
 * A session id is not just a routing key: it becomes a launcher *filename*, a
 * window *title*, and text inside a generated bash/cmd script and (on macOS)
 * inside an AppleScript that `osascript` executes. It arrives from an MCP tool
 * call's `target` argument, which is externally supplied input. A quote, a
 * backslash, a backtick, a `$`, or a path separator in that value is a way out
 * of the intended string context and into arbitrary command execution.
 *
 * So the rule is a strict allow-list, not escaping: letters, digits, `_`, `-`,
 * 1..64 characters. Everything in that set is inert in bash, in cmd, in
 * AppleScript, and as a path component. Callers reject; nothing sanitises,
 * because silently rewriting an id would route a turn to a different session
 * than the caller named.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `pi-broker: invalid session id ${JSON.stringify(sessionId)}. A session id ` +
        "must be 1-64 characters of A-Z a-z 0-9 _ - : it becomes a filename, a " +
        "window title, and part of a generated launch script, so anything else " +
        "is rejected rather than escaped.",
    );
  }
  return sessionId;
}

/**
 * Guard the *operator-supplied* strings that also end up inside a generated
 * script (the repository root and the socket path). These are not attacker
 * input in the threat model — but a path holding a quote or a `$` would break
 * the same string contexts, so refuse loudly instead of emitting a broken or
 * surprising launcher.
 */
function assertEmbeddable(label, value, platform) {
  const forbidden =
    platform === "win32" ? /["%\r\n&|<>^]/ : /["'`$\\\r\n]/;
  if (forbidden.test(value)) {
    throw new Error(
      `pi-broker: ${label} contains a character that cannot be embedded in a ` +
        `launch script on ${platform}: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Terminal emulators tried on Linux/BSD, in order of preference:
 * the distro's configured choice first (Debian's `x-terminal-emulator`
 * alternative), then the common desktop emulators, then `xterm` as the
 * lowest common denominator. Each entry says how *that* program takes a
 * command, because they genuinely disagree (`-e` vs `--` vs `--command`).
 *
 * Window titles are not passed as flags here on purpose: the flags are the
 * least portable part of every one of these CLIs (gnome-terminal deprecated
 * `--title`, alacritty never had `-T`). The generated launcher sets the title
 * itself with an OSC 0 escape, which every one of these emulators honours.
 */
const UNIX_TERMINALS = [
  { name: "x-terminal-emulator", args: (launcher) => ["-e", "bash", launcher] },
  { name: "gnome-terminal", args: (launcher) => ["--", "bash", launcher] },
  { name: "konsole", args: (launcher) => ["-e", "bash", launcher] },
  {
    name: "xfce4-terminal",
    args: (launcher) => ["--command", `bash ${shellQuote(launcher)}`],
  },
  { name: "alacritty", args: (launcher) => ["-e", "bash", launcher] },
  { name: "kitty", args: (launcher) => ["bash", launcher] },
  { name: "wezterm", args: (launcher) => ["start", "--", "bash", launcher] },
  { name: "foot", args: (launcher) => ["bash", launcher] },
  { name: "xterm", args: (launcher) => ["-e", "bash", launcher] },
];

/**
 * Is this Linux actually a WSL distribution?
 *
 * It matters because WSL is where most "Windows" use of this project will
 * really happen, and it is Linux to `process.platform` — but a WSL without
 * WSLg has no DISPLAY and no Linux terminal emulator, while still being able
 * to open a *Windows* console through interop. Telling that user to "install
 * gnome-terminal" would be wrong advice.
 */
export function isWsl({ env = process.env, readProcVersion = defaultProcVersion } = {}) {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return /microsoft/i.test(readProcVersion());
}

function defaultProcVersion() {
  try {
    return fs.readFileSync("/proc/version", "utf8");
  } catch {
    return "";
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** Minimal PATH lookup: no dependency, and injectable so tests can fake it. */
export function makeWhich(platform = process.platform, env = process.env) {
  const extensions =
    platform === "win32"
      ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  return (name) => {
    const dirs = (env.PATH || env.Path || "").split(
      platform === "win32" ? ";" : ":",
    );
    for (const dir of dirs) {
      if (!dir) continue;
      for (const extension of extensions) {
        const hasExtension =
          extension &&
          name.toLowerCase().endsWith(extension.toLowerCase());
        const candidate = path.join(dir, hasExtension ? name : name + extension);
        try {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) return candidate;
        } catch {
          // next candidate
        }
      }
    }
    return null;
  };
}

/**
 * Decide how — or whether — this machine can put a terminal window on screen.
 *
 * Always returns an object. `kind: null` means "cannot open a window here",
 * and `reason` says why in the caller's words. There is deliberately no
 * "well, run it hidden then" branch: not being able to show the session is a
 * hard failure for this project, not a degraded mode.
 */
export function detectTerminal({
  platform = process.platform,
  env = process.env,
  which = makeWhich(platform, env),
} = {}) {
  if (env.PI_SESSION_OPEN) {
    return { kind: "custom", command: env.PI_SESSION_OPEN };
  }

  if (platform === "darwin") {
    const osascript = which("osascript") || "/usr/bin/osascript";
    if (!fs.existsSync(osascript)) {
      return {
        kind: null,
        reason:
          "macOS without osascript: Terminal.app cannot be driven from here",
      };
    }
    return { kind: "osascript", command: osascript };
  }

  if (platform === "win32") {
    const windowsTerminal = which("wt.exe");
    if (windowsTerminal)
      return { kind: "windows-terminal", command: windowsTerminal };
    const cmd =
      which("cmd.exe") ||
      (env.ComSpec && fs.existsSync(env.ComSpec) ? env.ComSpec : null);
    if (cmd) return { kind: "cmd", command: cmd };
    const powershell = which("powershell.exe") || which("pwsh.exe");
    if (powershell) return { kind: "powershell", command: powershell };
    return {
      kind: null,
      reason:
        "no wt.exe, cmd.exe, or PowerShell found on PATH (a Server Core or " +
        "container image with no console host)",
    };
  }

  // Linux and other POSIX desktops. WSL lands here too — it *is* Linux as far
  // as Node is concerned — and takes the emulator path whenever WSLg or an X
  // server gives it a display.
  const wsl = platform === "linux" && isWsl({ env });

  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    for (const terminal of UNIX_TERMINALS) {
      const command = which(terminal.name);
      if (command)
        return {
          kind: "emulator",
          command,
          name: terminal.name,
          args: terminal.args,
        };
    }
  }

  // A WSL distro with no display can still put a real window on the real
  // Windows desktop through interop: the Windows terminal runs `wsl.exe`,
  // which runs the ordinary Linux launcher inside this distro. Same visible,
  // joinable session; the window frame just belongs to Windows.
  if (wsl) {
    const windowsTerminal = which("wt.exe");
    if (windowsTerminal)
      return {
        kind: "wsl-windows-terminal",
        command: windowsTerminal,
        distro: env.WSL_DISTRO_NAME || null,
      };
    const cmd = which("cmd.exe");
    if (cmd)
      return {
        kind: "wsl-cmd",
        command: cmd,
        distro: env.WSL_DISTRO_NAME || null,
      };
  }

  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return {
      kind: null,
      reason: wsl
        ? "this WSL distro has no graphical display (no WSLg, no X server) and " +
          "Windows interop is unavailable (no wt.exe or cmd.exe on PATH)"
        : "no graphical display (neither DISPLAY nor WAYLAND_DISPLAY is set), " +
          "so no terminal emulator can open a window",
    };
  }
  return {
    kind: null,
    reason:
      "no terminal emulator found on PATH (looked for " +
      UNIX_TERMINALS.map((t) => t.name).join(", ") +
      ")",
  };
}

/** The exact command a human should run to start the session by hand. */
export function manualCommand({
  platform = process.platform,
  socket,
  session,
  piCommand = DEFAULT_PI_COMMAND,
}) {
  if (platform === "win32") {
    return (
      `  set "PI_BROKER_SOCKET=${socket}"\n` +
      `  set "PI_BROKER_SESSION_ID=${session}"\n` +
      `  ${piCommand}`
    );
  }
  return (
    `  PI_BROKER_SOCKET=${socket} PI_BROKER_SESSION_ID=${session} \\\n` +
    `    ${piCommand}`
  );
}

/** The one honest "cannot show you a window" message, shared by all callers. */
export function noTerminalMessage({
  platform = process.platform,
  reason,
  socket,
  session,
  piCommand = DEFAULT_PI_COMMAND,
}) {
  const install =
    platform === "win32"
      ? "Install Windows Terminal, or run the session from a console you opened yourself."
      : platform === "darwin"
        ? "Terminal.app plus osascript is required."
        : /WSL distro/.test(reason ?? "")
          ? "Update to a WSL release with WSLg, or make wt.exe reachable from this distro (Windows interop), or run an X server."
          : "Install a terminal emulator (for example xterm or gnome-terminal) and run this from a graphical session.";
  return (
    `pi-broker: cannot open a visible terminal window for session '${session}': ${reason}. ` +
    `${install} Pi Broker will not start a hidden session instead. ` +
    "Start one by hand:\n" +
    manualCommand({ platform, socket, session, piCommand })
  );
}

/**
 * Write the per-session launcher script the terminal window will run.
 *
 * One launcher file per session, so the platform-specific launch command only
 * ever has to name a path and no shell quoting has to survive two parsers.
 * Returns its absolute path.
 */
export function writeLauncher({
  platform = process.platform,
  root,
  runDir,
  socket,
  session,
  piCommand = DEFAULT_PI_COMMAND,
  title = `pi-broker ${session}`,
}) {
  assertSessionId(session);
  assertEmbeddable("repository root", root, platform);
  assertEmbeddable("socket path", socket, platform);
  if (platform === "win32") {
    const launcher = path.join(runDir, `${session}.cmd`);
    // `call` so a .cmd on the session command line (npm.cmd) returns here
    // rather than ending this script; the window stays under cmd /k either way.
    fs.writeFileSync(
      launcher,
      [
        "@echo off",
        `title ${title}`,
        // cmd's `cd /d` wants backslashes; Node hands out native separators on
        // Windows anyway, this just makes a hand-passed path behave too.
        `cd /d "${root.replaceAll("/", "\\")}"`,
        `set "PI_BROKER_SOCKET=${socket}"`,
        `set "PI_BROKER_SESSION_ID=${session}"`,
        `echo === ${title} ===`,
        `echo socket: ${socket}`,
        `call ${piCommand}`,
        "",
      ].join("\r\n"),
    );
    return launcher;
  }

  const launcher = path.join(runDir, `${session}.sh`);
  fs.writeFileSync(
    launcher,
    [
      "#!/usr/bin/env bash",
      `cd "${root}"`,
      `export PI_BROKER_SOCKET="${socket}"`,
      `export PI_BROKER_SESSION_ID="${session}"`,
      // Set the window title from inside the window: the emulators disagree
      // about title flags, but they all honour OSC 0.
      `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
      `echo "=== ${title} ==="`,
      `echo "socket: ${socket}"`,
      `exec ${piCommand}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return launcher;
}

/**
 * Build the argv that opens ONE window running `launcher`, for every platform
 * except macOS (which needs a single AppleScript covering all sessions at
 * once — see buildAppleScript).
 *
 * Pure and exported so the Windows branch, which cannot be executed on this
 * project's development machines, is still covered by a unit test.
 */
export function planLaunch({ terminal, launcher, title }) {
  switch (terminal.kind) {
    case "custom":
      return { command: terminal.command, args: [launcher, title] };

    case "emulator":
      return { command: terminal.command, args: terminal.args(launcher) };

    // `wt.exe new-tab --title <title> <commandline>`: new-tab is the documented
    // subcommand and --title its documented option; the trailing command line
    // is run in the new tab. cmd /k keeps the console open after Pi exits so a
    // crash is visible rather than a window that blinks out.
    case "windows-terminal":
      return {
        command: terminal.command,
        args: ["new-tab", "--title", title, "cmd.exe", "/k", launcher],
      };

    // `start "<title>" <command>`: cmd's own builtin. The first quoted argument
    // is consumed as the new window's title, which is exactly why it must be
    // present — omit it and cmd treats a quoted path as the title instead.
    case "cmd":
      return {
        command: terminal.command,
        args: ["/c", "start", title, "cmd.exe", "/k", launcher],
      };

    // WSL without a display: a Windows-side window whose contents are this
    // distro. `wsl.exe [-d <distro>] -- <command>` is the documented way to run
    // a Linux command line in a named distribution, and wt.exe/cmd.exe treat
    // it as any other command line.
    case "wsl-windows-terminal":
      return {
        command: terminal.command,
        args: [
          "new-tab",
          "--title",
          title,
          "wsl.exe",
          ...(terminal.distro ? ["-d", terminal.distro] : []),
          "--",
          "bash",
          launcher,
        ],
      };

    case "wsl-cmd":
      return {
        command: terminal.command,
        args: [
          "/c",
          "start",
          title,
          "wsl.exe",
          ...(terminal.distro ? ["-d", terminal.distro] : []),
          "--",
          "bash",
          launcher,
        ],
      };

    // Start-Process launches a detached process in its own window; it has no
    // title parameter, so the launcher's own `title` line does that job.
    case "powershell":
      return {
        command: terminal.command,
        args: [
          "-NoProfile",
          "-Command",
          `Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','${launcher.replaceAll("'", "''")}'`,
        ],
      };

    default:
      throw new Error(`unsupported terminal kind: ${terminal.kind}`);
  }
}

/**
 * The macOS window opener, unchanged in behaviour from the original shell
 * implementation and kept as one AppleScript on purpose:
 *  - if Terminal was not already running, `activate` opens a startup window
 *    and a command sent immediately can be swallowed, so wait, then run the
 *    first session in that window instead of leaving it stranded and empty;
 *  - Pi sets its own window title on startup, so re-assert the labels once
 *    the sessions have settled. Without that, both windows end up with the
 *    same Pi-generated title and switching between them stops being obvious.
 */
export function buildAppleScript(entries) {
  let script =
    'set wasRunning to (application "Terminal" is running)\n' +
    'tell application "Terminal"\n' +
    "  activate\n" +
    "  if not wasRunning then delay 2\n";
  entries.forEach((entry, position) => {
    const index = position + 1;
    // Both values are already constrained (the title is `pi-broker <validated
    // session id>`, the launcher path is a run dir plus that same id), but this
    // is the string that osascript will execute, so it re-checks rather than
    // trusting its caller.
    assertEmbeddable("launcher path", entry.launcher, "darwin");
    assertSessionId(entry.session);
    if (index === 1) {
      script +=
        `  if wasRunning or (count of windows) is 0 then\n` +
        `    set tab${index} to do script "bash '${entry.launcher}'"\n` +
        `  else\n` +
        `    set tab${index} to do script "bash '${entry.launcher}'" in front window\n` +
        `  end if\n`;
    } else {
      script += `  set tab${index} to do script "bash '${entry.launcher}'"\n`;
    }
    script += `  set custom title of tab${index} to "${entry.title}"\n`;
  });
  script += "  delay 5\n";
  entries.forEach((entry, position) => {
    script += `  set custom title of tab${position + 1} to "${entry.title}"\n`;
  });
  return script + "end tell";
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    // A terminal emulator that is going to fail on its arguments fails
    // immediately; give it a beat to do so, then stop caring — a healthy
    // window outlives this process by design.
    //
    // This timer is deliberately NOT unref'd: unref'ing it lets the opener
    // process exit before the promise settles, which Node reports as an
    // "unsettled top-level await" and which made the CLI look like it had
    // failed even though the window was open.
    setTimeout(resolve, 150);
  });
}

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${path.basename(command)} exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

/**
 * Open one visible, interactive Pi window per session.
 * Throws — never falls back to anything headless — if it cannot.
 */
export async function openPiWindows({
  root,
  runDir,
  socket,
  sessions,
  platform = process.platform,
  env = process.env,
  terminal = detectTerminal({ platform, env }),
}) {
  const piCommand = env.PI_SESSION_PI_COMMAND || DEFAULT_PI_COMMAND;

  // Validate every id before anything is written or launched: a bad id must
  // not leave half the windows open and a launcher file on disk.
  for (const session of sessions) {
    try {
      assertSessionId(session);
    } catch (error) {
      error.code = "PI_INVALID_INPUT";
      throw error;
    }
  }

  if (terminal.kind === null) {
    const error = new Error(
      noTerminalMessage({
        platform,
        reason: terminal.reason,
        socket,
        session: sessions[0],
        piCommand,
      }),
    );
    error.code = "PI_NO_TERMINAL";
    throw error;
  }

  const entries = sessions.map((session) => ({
    session,
    title: `pi-broker ${session}`,
    launcher: writeLauncher({
      platform,
      root,
      runDir,
      socket,
      session,
      piCommand,
    }),
  }));

  // macOS: one AppleScript for every window (see buildAppleScript).
  if (terminal.kind === "osascript") {
    await runToCompletion(terminal.command, ["-e", buildAppleScript(entries)]);
    return entries;
  }

  for (const entry of entries) {
    const { command, args } = planLaunch({
      terminal,
      launcher: entry.launcher,
      title: entry.title,
    });
    // The test seam behaves like the old shell opener: run it, and let its
    // exit status decide whether the window opened.
    if (terminal.kind === "custom") await runToCompletion(command, args);
    else await spawnDetached(command, args);
  }
  return entries;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [root, runDir, socket, ...sessions] = process.argv.slice(2);
  if (!root || !runDir || !socket || sessions.length === 0) {
    process.stderr.write(
      "usage: open-pi-windows.mjs <root> <run-dir> <socket> <session>...\n",
    );
    process.exit(2);
  }
  try {
    await openPiWindows({ root, runDir, socket, sessions });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.code === "PI_INVALID_INPUT" ? 2 : 3);
  }
}
