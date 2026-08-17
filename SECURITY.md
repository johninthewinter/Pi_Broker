# Security

## Local-only contract

Pi Broker is an experimental, local-only proof of concept for a single trusted
user. The broker communicates through a local Unix socket (`<socket-path>`);
the socket is the trust boundary, not a production authentication mechanism.
Use only a repository-relative checkout and placeholder paths in host setup.

The Pi bridge must be loaded explicitly with `--extension` in each interactive
Pi process. Delegated operations retain the Strong Cards no-delete and
no-external-worktree policy. This workflow forbids Pi `-p`, print, JSON, and RPC
modes. Do not use forbidden API keys; the proof uses a deterministic local test
provider and no real API key.

Standalone Pi is unchanged, including its headless modes, and remains
user-controlled. The broker does not replace the Pi executable or change global
host configuration.

## Host MCP setup

Configure Claude Code, Codex, or OpenCode to run the repository's stdio MCP
adapter from the repository root, using a placeholder socket path:

```text
command: npm exec -- pi-broker mcp
working directory: repository root
```

With no socket argument the adapter uses a deterministic per-user path
(`/tmp/pi-broker-<uid>/broker.sock`) in a directory it creates with mode `0700`,
starts a broker there if none is listening, and opens a session window on first
use. That directory and socket are still the trust boundary and still assume a
single trusted user on the machine — auto-provisioning changes who *starts* the
broker, not who may talk to it. Set `PI_BROKER_AUTOPROVISION=0` to disable it,
or pass an explicit socket path to keep a host on a broker you started yourself.
Auto-provisioning only ever launches the ordinary interactive Pi TUI in a
visible terminal window — Terminal.app on macOS, an installed terminal emulator
on Linux, Windows Terminal / `cmd.exe` / PowerShell on Windows — and if it
cannot open one it fails with an error rather than starting a hidden session.

## Session ids are untrusted input

A session id reaches the machine as the `target` argument of an MCP tool call,
and it ends up as a launcher filename, a terminal window title, and text inside
a generated launch script — on macOS, inside an AppleScript executed by
`osascript`. It is therefore validated as a strict allow-list,
`[A-Za-z0-9_-]{1,64}`, and rejected rather than escaped or rewritten: at the MCP
boundary (`src/mcp-server.mjs`, both `pi_prompt` and `pi_interrupt`) and again
inside `ensureSession` (`src/autoprovision.mjs`), because that function is also
reachable directly. The repository root and socket path are likewise refused if
they contain a character that cannot be embedded in the generated launcher.

Keep the broker and both interactive Pi sessions in separately opened
terminals. Start each Pi session with `PI_BROKER_SOCKET=<socket-path>` and a
`PI_BROKER_SESSION_ID=<unique-session-id>`; use the same socket value in both
terminals, but distinct session IDs so the broker can target them individually. Do not expose the Unix socket, add credentials to these files, or
copy a machine-specific path into shared configuration.

## Disclosure and limitations

Do not publish credentials, private paths, socket contents, or host
configuration in issues or proof artifacts. Report a suspected security issue
privately to the repository maintainer rather than opening a public issue with
sensitive details.

This POC does not prove production authentication or multi-user isolation,
persistence or crash reconnect, terminal byte-stream attachment, automatic
worktree creation, card hashing, native Windows or WSL behavior, production
protocol stability, or a full coding task against a real model. The Linux
window-opening path is proved in a Linux container (real display, real terminal
emulator, and the no-terminal refusal); the native Windows and WSL-interop
paths are implemented and unit-tested but have never been run on real Windows
hardware. These are
experimental limitations, not support commitments.

See [PROOF-INDEX.md](PROOF-INDEX.md) and
[docs/proofs/2026-08-11-interactive-pi-poc.md](docs/proofs/2026-08-11-interactive-pi-poc.md)
for the executable evidence and its boundaries.
