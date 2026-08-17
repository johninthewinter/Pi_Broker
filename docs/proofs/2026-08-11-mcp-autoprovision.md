# Proof — the MCP adapter provisions the broker and a visible Pi session by itself

Date: 2026-08-11 · macOS 26.5.2 · Pi 0.84.1 · Node 22.23.1

**Claim under test:** a host can point at the stdio MCP adapter and start calling
tools with **no `npm run quickstart` and no manual terminal sequence run first**,
and what comes up is a real, visible, joinable interactive Pi session — never a
headless one.

The delegated model is the repository's deterministic local provider
(`scripts/fake-openai-server.mjs`), exactly as `npm run poc` uses it: no API key,
no external network. The invariant it must not break is the *Pi process shape*,
and that is asserted from the real process table below.

---

## 1 — Cold start: nothing running

```console
$ ls -la /tmp/pi-ap-proof
total 0
drwxr-xr-x@   2 <user>  wheel     64 Aug 11 16:54 .
$ ps -ax -o pid,command | grep -E "broker\.mjs|[p]i --extension" | grep -v grep
(no broker for this run; no session on this socket)
```

## 2 — A cold MCP host connects and calls a tool

The driver is an ordinary MCP client speaking to `node bin/pi-broker.mjs mcp`
**with no socket argument at all**:

```console
$ node .proof-tmp/proof-client.mjs "$PWD" /tmp/pi-ap-proof "$PI_CMD" HOST-1 session-a PROOF_COLD_START
[HOST-1] connected in 189ms
[HOST-1] pi_list -> {"sessions":[]}
[HOST-1] pi_prompt(session-a) in 5216ms -> {"target":"session-a","response":"POC_REPLY:PROOF_COLD_START"}
[HOST-1] pi_list -> {"sessions":["session-a"]}
```

Note the shape of it: connecting opened **no** window (`pi_list -> []`), and the
first `pi_prompt` created the session it named and got a real answer back from
it in one call.

## 3 — What actually came up

```console
$ ps -ax -o pid,ppid,command | grep "[b]roker.mjs /tmp/pi-ap-proof"
23927     1 <node> .../src/broker.mjs /tmp/pi-ap-proof/broker.sock

$ ps -ax -o pid,command | grep "[p]i-broker-poc"
23983 npm exec pi --provider pi-broker-poc --model deterministic \
        --extension ./extensions/pi-broker-bridge.ts \
        --extension ./test/fixtures/fake-provider-extension.ts \
        --no-extensions --no-skills --no-prompt-templates --no-context-files \
        --no-session --offline --tui-mode regular

$ ps -ax -o command | grep "[p]i-broker-poc" | grep -E -- " -p | --print | --mode json| --mode rpc"
no -p / --print / --mode json / --mode rpc present
```

The broker's parent is `1` — it is detached on purpose, so it outlives the
adapter process and a reconnecting host finds the same broker.

## 4 — A human can see it and type into it

The window is a real Terminal.app window with the expected label:

```console
$ osascript -e 'tell application "Terminal" to get custom title of every window'
pi-broker session-a
...
```

Its on-screen contents, read back from Terminal itself:

```text
bash '/tmp/pi-ap-proof/session-a.sh'
=== pi-broker session-a ===
socket: /tmp/pi-ap-proof/broker.sock
 pi v0.84.1
 escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more
[Extensions]
  fake-provider-extension.ts, pi-broker-bridge.ts
 PROOF_COLD_START
 POC_REPLY:PROOF_COLD_START
```

Then a human turn typed straight into that same TUI:

```console
$ osascript -e 'tell application "Terminal" to do script "PROOF_HUMAN_TYPED" in tab 1 of window id 10939'
```

```text
 PROOF_COLD_START
 POC_REPLY:PROOF_COLD_START
 PROOF_HUMAN_TYPED
 POC_REPLY:PROOF_HUMAN_TYPED
```

The delegated turn and the human turn are in one conversation, in a window the
human was looking at. Auto-provisioning did not make the session invisible.

## 5 — A second host connection does not duplicate anything

```console
=== before second connection ===
broker pid: 23927
socket inode: 36124798
terminal windows: 10
pi processes on this socket: 1

[HOST-2] connected in 126ms
[HOST-2] pi_list -> {"sessions":["session-a"]}
[HOST-2] pi_prompt(session-a) in 28ms -> {"target":"session-a","response":"POC_REPLY:PROOF_SECOND_HOST"}

=== after second connection ===
broker pid: 23927  (same as before: YES)
socket inode: 36124798  (same: YES)
terminal windows: 10  (was 10)
pi processes on this socket: 1  (was 1)
```

Same broker, same socket, no extra window, and the 28 ms round trip shows the
provisioning path was skipped entirely — the existing session was reused.

## 6 — A new target on an existing broker gets exactly one new window

```console
before: windows=10 pi-procs=1
[HOST-3] connected in 92ms
[HOST-3] pi_list -> {"sessions":["session-a"]}
[HOST-3] pi_prompt(session-b) in 5223ms -> {"target":"session-b","response":"POC_REPLY:PROOF_NEW_TARGET"}
[HOST-3] pi_list -> {"sessions":["session-a","session-b"]}
after:  windows=11 pi-procs=2  (exactly one more of each)
```

## 7 — The default socket is deterministic, and two hosts share it

With no socket argument and no environment override at all:

```console
$ ls -d /tmp/pi-broker-501
ls: /tmp/pi-broker-501: No such file or directory
$ node .proof-tmp/default-path.mjs HOST-D1
HOST-D1 pi_list -> {"sessions":[]}
broker pid after 1st: 29091
$ node .proof-tmp/default-path.mjs HOST-D2
HOST-D2 pi_list -> {"sessions":[]}
broker pid after 2nd: 29091
$ ls -la /tmp/pi-broker-501
drwx------@ 4 <user> wheel  128 Aug 11 16:57 .
srwxr-xr-x@ 1 <user> wheel    0 Aug 11 16:57 broker.sock
```

## 8 — A stale socket from a killed broker recovers instead of wedging

```console
$ kill -9 29091
broker killed; stale socket left behind:
srwxr-xr-x@ 1 <user> wheel 0 Aug 11 16:57 /tmp/pi-broker-501/broker.sock
$ node .proof-tmp/default-path.mjs HOST-D3
HOST-D3 pi_list -> {"sessions":[]}
new broker pid: 29374
```

## 9 — Nothing that already worked regressed

```console
$ npm test
# tests 15
# pass 15
# fail 0

$ npm run poc
"pi_command_shape": "interactive; no -p, --print, --mode json, or --mode rpc",
"verdict": "PASS"
```

## Limitations of this proof

- macOS Terminal.app only. On any machine where `osascript` cannot open a
  window, `pi_prompt` returns an error naming the manual command; it never
  falls back to a hidden Pi. Covered by
  `node --test test/autoprovision.test.mjs` →
  *a machine that cannot open a window gets an honest error, never a hidden session*.
- The model behind the auto-provisioned Pi here is the deterministic local
  provider, so section 2's `POC_REPLY:` answers prove routing and visibility,
  not model quality. Real-provider behavior is unchanged and untested here.
- Provisioning latency was ~5 s in this run (dominated by the AppleScript
  window-title settle). A slower cold Pi boot is bounded by
  `PI_BROKER_SESSION_TIMEOUT_MS` (default 45 s), after which the tool returns
  "the window is open, Pi is still starting, call again" rather than hanging
  past a host's own request timeout.
