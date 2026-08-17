# Interactive Pi broker POC — 2026-08-11

## Question

Can an external controller and a human both operate ordinary interactive Pi
sessions, while preserving Strong Cards no-delete/no-escape behavior and
remaining usable from Claude Code, Codex, and OpenCode?

## Tested stack

- macOS host
- Pi `0.84.1`
- Node.js `22.23.1`
- `@gotgenes/pi-permission-system` `25.0.0`
- `@modelcontextprotocol/sdk` `1.30.0`
- Claude Code `2.1.227`
- Codex CLI `0.147.0`
- OpenCode `1.18.5`

The interactive proof uses a deterministic localhost test provider. It removes
credential-like environment variables from Pi's child environment, sets Pi
offline, and makes no external model call.

## Fail-first baseline

Before the POC files existed, the baseline commit had no `package.json`:

```text
$ npm test
npm error code ENOENT
npm error Could not read package.json
exit 254
```

## Passing commands

### Deterministic suite

```text
$ npm test
4 tests, 4 passed, 0 failed
```

The suite covers broker registration/routing/isolation, duplicate session ID
rejection, the host-neutral CLI, and MCP list/prompt/interrupt calls.

### Real interactive Pi PTYs

```text
$ npm run poc
verdict: PASS
```

Passing assertions:

- `two_interactive_sessions_registered`
- `process_table_confirms_no_headless_flags`
- `broker_prompt_enters_as_extension_user_input`
- `remote_prompt_response_visible_in_real_tui`
- `human_and_broker_share_same_interactive_session`
- `remote_interrupt_returns_session_to_idle`
- `targeted_routing_reaches_second_session`
- `host_neutral_cli_returns_target_response`
- `permission_layer_denies_delete`
- `permission_layer_denies_worktree_escape`
- `graceful_remote_shutdown`

The process-table check rejects `-p`, `--print`, and `--mode`; the spawned Pi
processes run their regular TUI in POSIX pseudo-terminals.

### Host MCP recognition

```text
$ npm run poc:hosts
verdict: PASS
claude_code_connected: true
codex_enabled: true
opencode_connected: true
isolated_configuration_removed: true
```

The script uses temporary Claude configuration, Codex command-line overrides,
and OpenCode's in-memory config environment. It does not modify real host
configuration and does not make model calls.

### Public-safety checks

```text
$ gitleaks detect --no-banner --source . --no-git --redact --exit-code 1
no leaks found

$ npm audit --omit=dev
found 0 vulnerabilities

$ npm pack --dry-run --json
exit 0; 15 intended files; no node_modules, bytecode, socket, or runtime artifact
```

The initial package dry-run exposed the machine's root-owned global npm cache;
the successful check used a task-specific temporary npm cache. No ownership or
global machine setting was changed.

### Fresh-worktree provisioning

A detached worktree was created from committed POC revision `eadd11d`. The
operator ran `npm ci` using the lockfile, followed by `npm test`, `npm run poc`,
and `npm run poc:hosts`. All commands exited 0. Therefore every implementation
card in the plan uses one explicit provisioning step: operator-run `npm ci`
before worker dispatch.

### Standalone Pi compatibility

`pi --help` on Pi 0.84.1 still advertises `--print, -p` for non-interactive
execution and `--mode` with text, JSON, and RPC choices. Pi Broker does not
replace the Pi executable or disable those modes. Its POC loads extensions
explicitly for the child processes under test, while `npm run poc:hosts`
reports `global_configuration_modified: false`. The non-headless requirement
therefore applies only when Pi is acting as a broker-controlled delegated
agent; independent standalone Pi usage remains unchanged.

## Corrected failed assumption

The first delete-policy attempt placed its disposable target outside the
worktree. Pi correctly denied it at the `external_directory` gate, so that run
did not prove the separate `bash rm` gate. The corrected POC uses an ignored
disposable file inside the dedicated worktree for delete denial, and a distinct
outside path for escape denial. Both assertions then passed.

## What this does not prove

- Production authentication or multi-user isolation
- Persistence or reconnect after broker/terminal crashes
- A remotely attachable terminal byte stream
- Automatic worktree creation or card hashing
- Windows or Linux behavior
- Production readiness of this POC protocol
- A full coding task against a real model

Those capabilities are not eligible for the implementation plan without their
own executable proof.
