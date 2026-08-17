#!/usr/bin/env python3
import json
import os
import pty
import re
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


def start_json_process(*args):
    process = subprocess.Popen(
        args,
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    line = process.stdout.readline().strip()
    if not line:
        raise RuntimeError(f"process did not become ready: {process.stderr.read()}")
    return process, json.loads(line)


class PiProcess:
    def __init__(self, session_id, socket_path, provider_url, config_dir, permission_extension):
        self.session_id = session_id
        self.output = bytearray()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            env = os.environ.copy()
            for key in list(env):
                upper = key.upper()
                if upper.endswith(("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD")):
                    env.pop(key, None)
            env.update(
                {
                    "PI_BROKER_SOCKET": socket_path,
                    "PI_BROKER_SESSION_ID": session_id,
                    "PI_BROKER_FAKE_PROVIDER_URL": provider_url,
                    "PI_CODING_AGENT_DIR": str(config_dir),
                    "PI_OFFLINE": "1",
                    "PI_TELEMETRY": "0",
                    "TERM": "xterm-256color",
                }
            )
            argv = [
                "pi",
                "--provider",
                "pi-broker-poc",
                "--model",
                "deterministic",
                "--extension",
                str(ROOT / "extensions" / "pi-broker-bridge.ts"),
                "--extension",
                str(ROOT / "test" / "fixtures" / "fake-provider-extension.ts"),
                "--extension",
                str(permission_extension),
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-context-files",
                "--no-session",
                "--offline",
                "--tui-mode",
                "regular",
            ]
            os.chdir(ROOT)
            os.execvpe("pi", argv, env)
        self.command = subprocess.check_output(
            ["ps", "-p", str(self.pid), "-o", "command="], text=True
        ).strip()
        os.set_blocking(self.fd, False)
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        while True:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.1)
                if ready:
                    chunk = os.read(self.fd, 65536)
                    if not chunk:
                        return
                    self.output.extend(chunk)
                elif not self.alive:
                    return
            except OSError:
                return

    @property
    def alive(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def type(self, text):
        os.write(self.fd, text.encode("utf-8") + b"\r")

    def clean_output(self):
        return ANSI.sub(b"", bytes(self.output)).replace(b"\r", b"")

    def stop(self):
        if self.alive:
            os.kill(self.pid, signal.SIGTERM)
        try:
            os.close(self.fd)
        except OSError:
            pass


class Controller:
    def __init__(self, socket_path):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.connect(socket_path)
        self.socket.setblocking(False)
        self.buffer = b""
        self.messages = []
        self.send({"type": "register", "role": "controller"})

    def send(self, value):
        self.socket.sendall(json.dumps(value).encode("utf-8") + b"\n")

    def pump(self):
        while True:
            try:
                chunk = self.socket.recv(65536)
                if not chunk:
                    return
                self.buffer += chunk
            except BlockingIOError:
                break
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if line.strip():
                self.messages.append(json.loads(line))

    def wait(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            match = next((message for message in self.messages if predicate(message)), None)
            if match:
                return match
            time.sleep(0.025)
        raise TimeoutError("controller event timeout")

    def command(self, request_id, target, action, text=None, delivery=None):
        message = {
            "type": "send",
            "id": request_id,
            "target": target,
            "action": action,
        }
        if text is not None:
            message["text"] = text
        if delivery is not None:
            message["delivery"] = delivery
        self.send(message)
        return self.wait(lambda item: item.get("id") == request_id and item.get("type") == "response")


def wait_for_output(pi_process, marker, timeout=12):
    encoded = marker.encode("utf-8")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if encoded in pi_process.clean_output():
            return
        if not pi_process.alive:
            raise RuntimeError(f"Pi {pi_process.session_id} exited before marker {marker}")
        time.sleep(0.05)
    tail = pi_process.clean_output()[-2000:].decode("utf-8", errors="replace")
    raise TimeoutError(f"missing marker {marker}; tail={tail!r}")


def main():
    assertions = {}
    protected = None
    with tempfile.TemporaryDirectory(prefix="pi-broker-poc-") as runtime:
        runtime_path = Path(runtime)
        socket_path = str(runtime_path / "broker.sock")
        config_dir = runtime_path / "pi-config"
        config_dir.mkdir()
        permission_dir = config_dir / "extensions" / "pi-permission-system"
        permission_dir.mkdir(parents=True)
        shutil.copyfile(
            ROOT / "test" / "fixtures" / "permission-profile.json",
            permission_dir / "config.json",
        )
        permission_extension = (
            ROOT
            / "node_modules"
            / "@gotgenes"
            / "pi-permission-system"
            / "src"
            / "index.ts"
        )

        fake, fake_ready = start_json_process("node", "scripts/fake-openai-server.mjs")
        broker, broker_ready = start_json_process("node", "src/broker.mjs", socket_path)
        controller = Controller(socket_path)
        alpha = PiProcess(
            "alpha", socket_path, fake_ready["url"], config_dir, permission_extension
        )
        beta = PiProcess(
            "beta", socket_path, fake_ready["url"], config_dir, permission_extension
        )
        processes = [alpha, beta]

        try:
            controller.wait(lambda item: item.get("event") == "connected" and item.get("sessionId") == "alpha")
            controller.wait(lambda item: item.get("event") == "connected" and item.get("sessionId") == "beta")
            controller.send({"type": "list", "id": "list"})
            listed = controller.wait(lambda item: item.get("id") == "list")
            assertions["two_interactive_sessions_registered"] = listed["sessions"] == ["alpha", "beta"]
            forbidden = (" -p ", " --print ", " --mode ")
            assertions["process_table_confirms_no_headless_flags"] = all(
                not any(flag in f" {process.command} " for flag in forbidden)
                for process in processes
            )

            controller.command("remote-alpha", "alpha", "prompt", "POC_REMOTE_ALPHA")
            remote_input = controller.wait(
                lambda item: item.get("sessionId") == "alpha"
                and item.get("event") == "input"
                and item.get("source") == "extension"
                and item.get("text") == "POC_REMOTE_ALPHA"
            )
            wait_for_output(alpha, "POC_REPLY:POC_REMOTE_ALPHA")
            assertions["broker_prompt_enters_as_extension_user_input"] = bool(remote_input)
            assertions["remote_prompt_response_visible_in_real_tui"] = True

            beta.type("POC_HUMAN_BETA")
            human_input = controller.wait(
                lambda item: item.get("sessionId") == "beta"
                and item.get("event") == "input"
                and item.get("source") == "interactive"
                and item.get("text") == "POC_HUMAN_BETA"
            )
            wait_for_output(beta, "POC_REPLY:POC_HUMAN_BETA")
            assertions["human_and_broker_share_same_interactive_session"] = bool(human_input)

            controller.command("long-alpha", "alpha", "prompt", "POC_LONG_ALPHA")
            controller.wait(
                lambda item: item.get("sessionId") == "alpha" and item.get("event") == "agent_start"
            )
            wait_for_output(alpha, "POC_LONG_TICK_0")
            controller.command("interrupt-alpha", "alpha", "interrupt")
            controller.wait(
                lambda item: item.get("sessionId") == "alpha" and item.get("event") == "agent_end"
            )
            time.sleep(0.2)
            assertions["remote_interrupt_returns_session_to_idle"] = alpha.alive

            cli = subprocess.run(
                [
                    "node",
                    "src/client.mjs",
                    socket_path,
                    "prompt",
                    "beta",
                    "POC_REMOTE_BETA",
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                timeout=20,
                check=True,
            )
            cli_result = json.loads(cli.stdout)
            wait_for_output(beta, "POC_REPLY:POC_REMOTE_BETA")
            assertions["targeted_routing_reaches_second_session"] = (
                b"POC_REPLY:POC_REMOTE_BETA" in beta.clean_output()
                and b"POC_REPLY:POC_REMOTE_BETA" not in alpha.clean_output()
            )
            assertions["host_neutral_cli_returns_target_response"] = (
                cli_result == {
                    "target": "beta",
                    "response": "POC_REPLY:POC_REMOTE_BETA",
                }
            )

            protected_dir = ROOT / ".poc"
            protected_dir.mkdir(exist_ok=True)
            protected = protected_dir / f"protected-{os.getpid()}.txt"
            if protected.exists():
                raise RuntimeError(f"refusing to replace pre-existing delete target: {protected}")
            protected.write_text("must survive", encoding="utf-8")
            controller.command(
                "deny-rm", "alpha", "prompt", f"POC_DENY_RM:{protected}"
            )
            rm_denial = controller.wait(
                lambda item: item.get("sessionId") == "alpha"
                and item.get("event") == "permission_decision"
                and item.get("surface") == "bash"
                and item.get("result") == "deny"
            )
            wait_for_output(alpha, "POC_TOOL_RESULT_RETURNED_TO_MODEL")
            assertions["permission_layer_denies_delete"] = bool(rm_denial) and protected.exists()

            outside = runtime_path.parent / f"pi-broker-escape-{os.getpid()}.txt"
            if outside.exists():
                raise RuntimeError(f"refusing to replace pre-existing escape target: {outside}")
            controller.command(
                "deny-write", "beta", "prompt", f"POC_DENY_WRITE:{outside}"
            )
            outside_denial = controller.wait(
                lambda item: item.get("sessionId") == "beta"
                and item.get("event") == "permission_decision"
                and item.get("surface") == "external_directory"
                and item.get("result") == "deny"
            )
            wait_for_output(beta, "POC_TOOL_RESULT_RETURNED_TO_MODEL")
            assertions["permission_layer_denies_worktree_escape"] = (
                bool(outside_denial) and not outside.exists()
            )

            for index, process in enumerate(processes):
                controller.command(f"shutdown-{index}", process.session_id, "shutdown")
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and any(process.alive for process in processes):
                time.sleep(0.05)
            assertions["graceful_remote_shutdown"] = not any(process.alive for process in processes)
        except Exception:
            controller.pump()
            print(
                json.dumps({"controller_messages": controller.messages}, indent=2),
                file=sys.stderr,
            )
            for process in processes:
                tail = process.clean_output()[-4000:].decode("utf-8", errors="replace")
                print(f"--- {process.session_id} TUI tail ---\n{tail}", file=sys.stderr)
            raise
        finally:
            for process in processes:
                process.stop()
            controller.socket.close()
            broker.send_signal(signal.SIGTERM)
            fake.send_signal(signal.SIGTERM)
            broker.wait(timeout=5)
            fake.wait(timeout=5)
            if protected is not None and protected.exists():
                protected.unlink()

    failed = [name for name, passed in assertions.items() if not passed]
    report = {
        "pi_command_shape": "interactive; no -p, --print, --mode json, or --mode rpc",
        "external_network": False,
        "credentials": False,
        "assertions": assertions,
        "verdict": "PASS" if not failed else "FAIL",
    }
    print(json.dumps(report, indent=2, sort_keys=True))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
