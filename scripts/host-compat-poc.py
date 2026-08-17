#!/usr/bin/env python3
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "src" / "mcp-server.mjs"
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def require(binary):
    path = shutil.which(binary)
    if not path:
        raise RuntimeError(f"required host binary is not installed: {binary}")
    return path


def run(args, *, env=None, cwd=ROOT):
    completed = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=30,
        check=True,
    )
    return ANSI.sub("", completed.stdout + completed.stderr)


def main():
    # This probe deliberately points every host at a throwaway socket that
    # nothing serves, to prove the adapter is *recognized* without a broker.
    # Auto-provisioning would helpfully start a real detached broker there and
    # then outlive the temporary directory, leaking one process per run — so it
    # is switched off for the probe. It has its own proof:
    # docs/proofs/2026-08-11-mcp-autoprovision.md.
    os.environ["PI_BROKER_AUTOPROVISION"] = "0"
    node = require("node")
    claude = require("claude")
    codex = require("codex")
    opencode = require("opencode")
    versions = {
        "claude": run([claude, "--version"]).strip(),
        "codex": run([codex, "--version"]).strip(),
        "opencode": run([opencode, "--version"]).strip(),
    }

    with tempfile.TemporaryDirectory(prefix="pi-broker-host-") as runtime:
        runtime_path = Path(runtime)
        unused_socket = runtime_path / "broker.sock"

        claude_env = os.environ.copy()
        claude_env["CLAUDE_CONFIG_DIR"] = str(runtime_path / "claude-config")
        run(
            [
                claude,
                "mcp",
                "add",
                "--scope",
                "user",
                "pi-broker",
                "--",
                node,
                str(SERVER),
                str(unused_socket),
            ],
            env=claude_env,
        )
        claude_output = run([claude, "mcp", "list"], env=claude_env)

        codex_output = run(
            [
                codex,
                "-c",
                f'mcp_servers.pi-broker.command="{node}"',
                "-c",
                "mcp_servers.pi-broker.args="
                + json.dumps([str(SERVER), str(unused_socket)]),
                "mcp",
                "list",
            ]
        )

        opencode_env = os.environ.copy()
        opencode_env["OPENCODE_CONFIG_CONTENT"] = json.dumps(
            {
                "mcp": {
                    "pi-broker": {
                        "type": "local",
                        "command": [node, str(SERVER), str(unused_socket)],
                        "enabled": True,
                    }
                }
            }
        )
        opencode_output = run(
            [opencode, "mcp", "list", "--pure"], env=opencode_env
        )

    def has_host_status(output, status):
        pattern = re.compile(
            rf"^.*\bpi-broker\b.*\b{re.escape(status)}\b.*$",
            re.IGNORECASE,
        )
        return any(pattern.match(line) for line in output.splitlines())

    assertions = {
        "claude_code_connected": has_host_status(claude_output, "Connected"),
        "codex_enabled": has_host_status(codex_output, "enabled"),
        "opencode_connected": has_host_status(opencode_output, "connected"),
        "isolated_configuration_removed": not runtime_path.exists(),
    }
    failed = [name for name, passed in assertions.items() if not passed]
    print(
        json.dumps(
            {
                "assertions": assertions,
                "host_versions": versions,
                "global_configuration_modified": False,
                "model_calls": False,
                "verdict": "PASS" if not failed else "FAIL",
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
