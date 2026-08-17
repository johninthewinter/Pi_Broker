// Platform branches of the shared window opener.
//
// The macOS branch is proven end to end by `npm run quickstart` and
// docs/proofs/2026-08-11-mcp-autoprovision.md; the Linux branch was proven end
// to end in a Linux container (real Xvfb display, real xterm windows, real
// broker round-trip, and both no-display and no-emulator refusals).
// The native Windows branch cannot be executed on this project's machines at
// all, so it is covered here the only honest way: by asserting the exact argv
// the code builds against the documented syntax of wt.exe, cmd.exe, and
// Start-Process.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_PI_COMMAND,
  assertSessionId,
  buildAppleScript,
  detectTerminal,
  isWsl,
  noTerminalMessage,
  openPiWindows,
  planLaunch,
  writeLauncher,
} from "../scripts/open-pi-windows.mjs";

/** A PATH lookup stub: only the named programs exist. */
const whichOnly = (...available) => (name) =>
  available.includes(name) ? `/usr/bin/${name}` : null;

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opener-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- detection ---------------------------------------------------------

test("Linux with a display picks the first terminal emulator that is installed", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { DISPLAY: ":0" },
    which: whichOnly("konsole", "xterm"),
  });
  assert.equal(terminal.kind, "emulator");
  assert.equal(terminal.name, "konsole", "preference order was not honoured");
});

test("Linux prefers the distro's configured x-terminal-emulator", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { WAYLAND_DISPLAY: "wayland-0" },
    which: whichOnly("x-terminal-emulator", "gnome-terminal", "xterm"),
  });
  assert.equal(terminal.name, "x-terminal-emulator");
});

test("Linux with no terminal emulator refuses, and says what to install", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { DISPLAY: ":0" },
    which: () => null,
  });
  assert.equal(terminal.kind, null);
  assert.match(terminal.reason, /no terminal emulator found/);
  assert.match(terminal.reason, /gnome-terminal/);
});

test("Linux with no graphical display refuses before looking for an emulator", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: {},
    which: () => assert.fail("must not search PATH with no display"),
  });
  assert.equal(terminal.kind, null);
  assert.match(terminal.reason, /DISPLAY/);
});

// WSL is the realistic majority of "Windows" use, and it is Linux to Node.
// With WSLg or an X server it is just the Linux path; without one it can still
// open a real window on the Windows desktop through interop.
test("WSL with a display is treated as plain Linux", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04", WAYLAND_DISPLAY: "wayland-0" },
    which: whichOnly("gnome-terminal", "wt.exe"),
  });
  assert.equal(terminal.kind, "emulator");
  assert.equal(terminal.name, "gnome-terminal");
});

test("WSL with no display opens a Windows-side window through interop", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
    which: whichOnly("wt.exe", "cmd.exe"),
  });
  assert.deepEqual(terminal, {
    kind: "wsl-windows-terminal",
    command: "/usr/bin/wt.exe",
    distro: "Ubuntu-24.04",
  });
  assert.deepEqual(
    planLaunch({
      terminal,
      launcher: "/run/session-a.sh",
      title: "pi-broker session-a",
    }),
    {
      command: "/usr/bin/wt.exe",
      args: [
        "new-tab",
        "--title",
        "pi-broker session-a",
        "wsl.exe",
        "-d",
        "Ubuntu-24.04",
        "--",
        "bash",
        "/run/session-a.sh",
      ],
    },
  );

  const viaCmd = detectTerminal({
    platform: "linux",
    env: { WSL_INTEROP: "/run/WSL/1_interop" },
    which: whichOnly("cmd.exe"),
  });
  assert.equal(viaCmd.kind, "wsl-cmd");
  assert.deepEqual(
    planLaunch({
      terminal: viaCmd,
      launcher: "/run/session-a.sh",
      title: "pi-broker session-a",
    }).args,
    [
      "/c",
      "start",
      "pi-broker session-a",
      "wsl.exe",
      "--",
      "bash",
      "/run/session-a.sh",
    ],
    "with no WSL_DISTRO_NAME the -d flag must be omitted, not passed empty",
  );
});

test("WSL with neither a display nor interop refuses with WSL-specific advice", () => {
  const terminal = detectTerminal({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
    which: () => null,
  });
  assert.equal(terminal.kind, null);
  assert.match(terminal.reason, /WSL distro/);
  const message = noTerminalMessage({
    platform: "linux",
    reason: terminal.reason,
    socket: "/tmp/b.sock",
    session: "session-a",
  });
  assert.match(message, /WSLg/);
  assert.doesNotMatch(message, /Install a terminal emulator/);
});

test("WSL is detected from the env or from /proc/version", () => {
  const noProc = () => "";
  assert.equal(isWsl({ env: { WSL_DISTRO_NAME: "x" }, readProcVersion: noProc }), true);
  assert.equal(isWsl({ env: { WSL_INTEROP: "/run/WSL/1" }, readProcVersion: noProc }), true);
  assert.equal(
    isWsl({
      env: {},
      readProcVersion: () => "Linux version 5.15.153.1-microsoft-standard-WSL2",
    }),
    true,
  );
  assert.equal(
    isWsl({ env: {}, readProcVersion: () => "Linux version 6.8.0-117-generic" }),
    false,
  );
});

test("Windows prefers Windows Terminal, then cmd.exe, then PowerShell", () => {
  const win = (...available) =>
    detectTerminal({
      platform: "win32",
      env: {},
      which: whichOnly(...available),
    }).kind;
  assert.equal(win("wt.exe", "cmd.exe", "powershell.exe"), "windows-terminal");
  assert.equal(win("cmd.exe", "powershell.exe"), "cmd");
  assert.equal(win("powershell.exe"), "powershell");
  const none = detectTerminal({
    platform: "win32",
    env: {},
    which: () => null,
  });
  assert.equal(none.kind, null);
  assert.match(none.reason, /wt\.exe, cmd\.exe, or PowerShell/);
});

test("the PI_SESSION_OPEN test seam overrides detection on every platform", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const terminal = detectTerminal({
      platform,
      env: { PI_SESSION_OPEN: "/opt/fake-opener" },
      which: () => null,
    });
    assert.deepEqual(terminal, { kind: "custom", command: "/opt/fake-opener" });
  }
});

// --- command construction ----------------------------------------------

test("Linux emulators are each invoked with their own documented command flag", () => {
  const launcher = "/run/session-a.sh";
  const expected = {
    "x-terminal-emulator": ["-e", "bash", launcher],
    "gnome-terminal": ["--", "bash", launcher],
    konsole: ["-e", "bash", launcher],
    "xfce4-terminal": ["--command", `bash '${launcher}'`],
    xterm: ["-e", "bash", launcher],
  };
  for (const [name, args] of Object.entries(expected)) {
    const terminal = detectTerminal({
      platform: "linux",
      env: { DISPLAY: ":0" },
      which: whichOnly(name),
    });
    assert.deepEqual(
      planLaunch({ terminal, launcher, title: "pi-broker session-a" }),
      { command: `/usr/bin/${name}`, args },
      `${name} launch command is wrong`,
    );
  }
});

// Windows syntax being asserted here, and where it comes from:
//   wt.exe   — `wt new-tab --title <title> <commandline>`; new-tab is the
//              documented subcommand, --title its documented option, and the
//              trailing command line runs in the new tab.
//   cmd.exe  — `start "<title>" <command>`: cmd's builtin, whose first quoted
//              argument is consumed as the window title.
//   pwsh     — `Start-Process -FilePath <exe> -ArgumentList <args>` launches a
//              detached process in its own window; it has no title parameter,
//              so the launcher's own `title` line does that job.
test("Windows: Windows Terminal gets a new titled tab running the launcher", () => {
  const terminal = { kind: "windows-terminal", command: "C:\\wt.exe" };
  assert.deepEqual(
    planLaunch({
      terminal,
      launcher: "C:\\run\\session-a.cmd",
      title: "pi-broker session-a",
    }),
    {
      command: "C:\\wt.exe",
      args: [
        "new-tab",
        "--title",
        "pi-broker session-a",
        "cmd.exe",
        "/k",
        "C:\\run\\session-a.cmd",
      ],
    },
  );
});

test("Windows: without wt.exe, cmd start opens a titled console window", () => {
  const terminal = { kind: "cmd", command: "C:\\Windows\\system32\\cmd.exe" };
  assert.deepEqual(
    planLaunch({
      terminal,
      launcher: "C:\\run\\session-a.cmd",
      title: "pi-broker session-a",
    }),
    {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: [
        "/c",
        "start",
        "pi-broker session-a",
        "cmd.exe",
        "/k",
        "C:\\run\\session-a.cmd",
      ],
    },
  );
});

test("Windows: the PowerShell fallback uses Start-Process with a quoted launcher", () => {
  const terminal = { kind: "powershell", command: "powershell.exe" };
  const { command, args } = planLaunch({
    terminal,
    launcher: "C:\\run\\session-a.cmd",
    title: "pi-broker session-a",
  });
  assert.equal(command, "powershell.exe");
  assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);
  assert.equal(
    args[2],
    "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','C:\\run\\session-a.cmd'",
  );
});

// --- launcher contents --------------------------------------------------

test("the POSIX launcher is the ordinary interactive Pi, with its own title", (t) => {
  const dir = tmpdir(t);
  const launcher = writeLauncher({
    platform: "linux",
    root: "/repo",
    runDir: dir,
    socket: "/tmp/b.sock",
    session: "session-a",
  });
  const body = fs.readFileSync(launcher, "utf8");
  assert.equal(path.basename(launcher), "session-a.sh");
  assert.match(body, /^cd "\/repo"$/m);
  assert.match(body, /^export PI_BROKER_SOCKET="\/tmp\/b\.sock"$/m);
  assert.match(body, /^export PI_BROKER_SESSION_ID="session-a"$/m);
  assert.match(body, /\\033\]0;%s\\007' 'pi-broker session-a'/);
  assert.equal(
    body.trimEnd().split("\n").pop(),
    `exec ${DEFAULT_PI_COMMAND}`,
    "the launcher must end by exec'ing the ordinary interactive Pi",
  );
  assert.ok((fs.statSync(launcher).mode & 0o111) !== 0, "launcher not executable");
});

test("the Windows launcher is a CRLF .cmd that titles its own console", (t) => {
  const dir = tmpdir(t);
  const launcher = writeLauncher({
    platform: "win32",
    root: "C:\\repo",
    runDir: dir,
    socket: "C:\\tmp\\b.sock",
    session: "session-a",
  });
  const body = fs.readFileSync(launcher, "utf8");
  assert.equal(path.basename(launcher), "session-a.cmd");
  assert.ok(body.includes("\r\n"), "a .cmd file needs CRLF line endings");
  assert.match(body, /^title pi-broker session-a\r$/m);
  assert.match(body, /^cd \/d "C:\\repo"\r$/m);
  assert.match(body, /^set "PI_BROKER_SOCKET=C:\\tmp\\b\.sock"\r$/m);
  assert.match(body, /^set "PI_BROKER_SESSION_ID=session-a"\r$/m);
  // `call`, because npm on Windows is npm.cmd and a .cmd invoked without
  // `call` never returns to this script.
  assert.match(body, new RegExp(`^call ${DEFAULT_PI_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\r$`, "m"));
  for (const forbidden of [" -p ", "--print", "--mode json", "--mode rpc"]) {
    assert.ok(!body.includes(forbidden), `Windows launcher must not contain ${forbidden}`);
  }
});

// --- macOS regression lock ----------------------------------------------

test("the macOS AppleScript is unchanged by the cross-platform rewrite", () => {
  const script = buildAppleScript([
    { session: "session-a", title: "pi-broker session-a", launcher: "/run/session-a.sh" },
    { session: "session-b", title: "pi-broker session-b", launcher: "/run/session-b.sh" },
  ]);
  // Byte-for-byte what the previous bash+AppleScript implementation emitted
  // for the same two sessions (verified by diffing against it), modulo one
  // leading space before `end tell` that AppleScript ignores.
  assert.equal(
    script,
    `set wasRunning to (application "Terminal" is running)
tell application "Terminal"
  activate
  if not wasRunning then delay 2
  if wasRunning or (count of windows) is 0 then
    set tab1 to do script "bash '/run/session-a.sh'"
  else
    set tab1 to do script "bash '/run/session-a.sh'" in front window
  end if
  set custom title of tab1 to "pi-broker session-a"
  set tab2 to do script "bash '/run/session-b.sh'"
  set custom title of tab2 to "pi-broker session-b"
  delay 5
  set custom title of tab1 to "pi-broker session-a"
  set custom title of tab2 to "pi-broker session-b"
end tell`,
  );
});

// --- honest failure -----------------------------------------------------

test("a machine with no terminal gets the exact manual command, per platform", () => {
  const posix = noTerminalMessage({
    platform: "linux",
    reason: "no terminal emulator found on PATH",
    socket: "/tmp/b.sock",
    session: "session-a",
  });
  assert.match(posix, /will not start a hidden session/);
  assert.match(posix, /Install a terminal emulator/);
  assert.match(
    posix,
    /PI_BROKER_SOCKET=\/tmp\/b\.sock PI_BROKER_SESSION_ID=session-a/,
  );
  assert.match(posix, /pi --extension \.\/extensions\/pi-broker-bridge\.ts/);

  const windows = noTerminalMessage({
    platform: "win32",
    reason: "no console host",
    socket: "C:\\tmp\\b.sock",
    session: "session-a",
  });
  assert.match(windows, /set "PI_BROKER_SOCKET=C:\\tmp\\b\.sock"/);
  assert.match(windows, /set "PI_BROKER_SESSION_ID=session-a"/);
  assert.match(windows, /Install Windows Terminal/);

  for (const message of [posix, windows]) {
    for (const forbidden of [" -p ", "--print", "--mode json", "--mode rpc"]) {
      assert.ok(
        !message.includes(forbidden),
        `the failure message must not suggest ${forbidden}`,
      );
    }
  }
});

test("openPiWindows refuses rather than opening nothing quietly", async (t) => {
  const dir = tmpdir(t);
  await assert.rejects(
    () =>
      openPiWindows({
        root: "/repo",
        runDir: dir,
        socket: "/tmp/b.sock",
        sessions: ["session-a"],
        platform: "linux",
        env: {},
        terminal: { kind: null, reason: "no terminal emulator found on PATH" },
      }),
    (error) => {
      assert.equal(error.code, "PI_NO_TERMINAL");
      assert.match(error.message, /Start one by hand/);
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(dir), [], "nothing should have been written");
});

// Regression: the detached-spawn path once resolved on an unref'd timer, so a
// standalone opener process exited before the await settled — Node reported
// "unsettled top-level await" and the caller saw a failure even though the
// window had opened. Only reproducible in a process that nothing else keeps
// alive, hence the child process here.
test("the opener process exits cleanly after launching a detached window", async (t) => {
  const dir = tmpdir(t);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `
    const { openPiWindows } = await import(${JSON.stringify(
      path.join(process.cwd(), "scripts", "open-pi-windows.mjs"),
    )});
    await openPiWindows({
      root: "/repo",
      runDir: ${JSON.stringify(dir)},
      socket: "/tmp/b.sock",
      sessions: ["session-a"],
      platform: "linux",
      env: {},
      terminal: { kind: "emulator", command: "/bin/echo", args: () => [] },
    });
    process.stdout.write("SETTLED");
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10000 },
  );
  assert.equal(stdout, "SETTLED");
  assert.doesNotMatch(stderr, /unsettled top-level await/);
});

// --- session id validation ---------------------------------------------

test("a session id that could escape a script context is rejected, not escaped", () => {
  const hostile = [
    '"; rm -rf /tmp"',
    'a" & calc.exe & "',
    "a`whoami`",
    "a$(id)",
    "../../etc/passwd",
    "a\nset custom title",
    "session a",
    "",
    "x".repeat(65),
    null,
  ];
  for (const value of hostile) {
    assert.throws(
      () => assertSessionId(value),
      /invalid session id/,
      `${JSON.stringify(value)} should have been rejected`,
    );
  }
  for (const value of ["session-a", "session_1", "A0", "x".repeat(64)]) {
    assert.equal(assertSessionId(value), value);
  }
});

test("a hostile session id never reaches a launcher file or a launch command", async (t) => {
  const dir = tmpdir(t);
  let spawned = false;
  await assert.rejects(
    () =>
      openPiWindows({
        root: "/repo",
        runDir: dir,
        socket: "/tmp/b.sock",
        sessions: ["session-a", '"; touch /tmp/pwned; echo "'],
        platform: "darwin",
        env: {},
        terminal: {
          kind: "custom",
          command: (() => {
            spawned = true;
            return "/bin/true";
          })(),
        },
      }),
    /invalid session id/,
  );
  assert.deepEqual(
    fs.readdirSync(dir),
    [],
    "a bad id in the list must abort before any launcher is written",
  );
  assert.ok(spawned, "sanity: the terminal object was constructed");
});

test("a path that cannot be embedded in a launch script is refused", (t) => {
  const dir = tmpdir(t);
  assert.throws(
    () =>
      writeLauncher({
        platform: "linux",
        root: '/repo/"; rm -rf /; echo "',
        runDir: dir,
        socket: "/tmp/b.sock",
        session: "session-a",
      }),
    /repository root contains a character/,
  );
  assert.throws(
    () =>
      writeLauncher({
        platform: "win32",
        root: "C:\\repo",
        runDir: dir,
        socket: "C:\\tmp\\%PATH%.sock",
        session: "session-a",
      }),
    /socket path contains a character/,
  );
});
