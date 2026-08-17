# Proof index

No capability is promoted from this proof-of-concept into the implementation
plan unless it has executable evidence here.

| Claim | Proof |
| --- | --- |
| A normal interactive Pi process can be remotely prompted without `-p`, JSON, or RPC mode | `npm run poc` → `process_table_confirms_no_headless_flags`, `broker_prompt_enters_as_extension_user_input` |
| A human and controller can use the same live Pi session | `npm run poc` → `human_and_broker_share_same_interactive_session` |
| Multiple Pi sessions can be targeted independently | `npm run poc` → `two_interactive_sessions_registered`, `targeted_routing_reaches_second_session` |
| A controller can interrupt and shut down a live Pi | `npm run poc` → `remote_interrupt_returns_session_to_idle`, `graceful_remote_shutdown` |
| Strong Cards delete and worktree-escape rules can be enforced | `npm run poc` → `permission_layer_denies_delete`, `permission_layer_denies_worktree_escape` |
| A host-neutral CLI returns the selected Pi's response | `npm run poc` → `host_neutral_cli_returns_target_response` |
| A stdio MCP adapter exposes list, prompt, and interrupt | `npm test` → `MCP exposes list, prompt, and interrupt over the broker` |
| Claude Code, Codex, and OpenCode recognize the same MCP adapter | `npm run poc:hosts` |
| The tracked POC contains no detected secrets | `gitleaks detect --no-banner --source . --no-git --redact --exit-code 1` |
| Runtime dependencies have no currently reported npm vulnerabilities | `npm audit --omit=dev` |
| The full acceptance set works from a clean committed checkout | detached worktree at `eadd11d`; `npm ci`, `npm test`, `npm run poc`, and `npm run poc:hosts` all exited 0 |
| Pi Broker does not remove standalone Pi headless usage | `pi --help` still advertises `--print, -p` and `--mode`; POC extensions are passed explicitly to child processes and host probing asserts `isolated_configuration_removed: true` (temporary per-host config directories are cleaned up, not left behind) |
| The local-only operating boundary is testable | `npm run poc` → two interactive sessions register, share human/controller use, enforce no-delete/no-worktree-escape; `npm run poc:hosts` → Claude Code, Codex, and OpenCode recognize the adapter without modifying global host configuration |
| The required Pi workflow uses ordinary interactive sessions with an explicit extension | `npm run poc` → `process_table_confirms_no_headless_flags`; the POC starts Pi with an explicit extension and rejects `-p`, `--print`, and `--mode` |
| A cold MCP host starts the broker and a visible interactive Pi session with no prior quickstart | [docs/proofs/2026-08-11-mcp-autoprovision.md](docs/proofs/2026-08-11-mcp-autoprovision.md); `npm test` → `a cold MCP connection starts the broker and provisions a session on first prompt` |
| A second MCP connection reuses the same broker and session instead of duplicating them | [docs/proofs/2026-08-11-mcp-autoprovision.md](docs/proofs/2026-08-11-mcp-autoprovision.md) §5; `npm test` → `a second MCP connection reuses the broker and does not duplicate a session` |
| Auto-provisioning refuses rather than falling back to a hidden Pi | `npm test` → `a machine that cannot open a window gets an honest error, never a hidden session`, `auto-provisioning never reaches for a headless Pi` |
| v0.1.0 was independently re-proven from a fresh detached worktree (`npm ci`, `npm test`, `npm run poc`, `npm run poc:hosts`, twice each) plus gitleaks/audit/pack | [docs/proofs/2026-08-11-v0.1.0-acceptance.md](docs/proofs/2026-08-11-v0.1.0-acceptance.md) |

Full command results and limitations: [docs/proofs/2026-08-11-interactive-pi-poc.md](docs/proofs/2026-08-11-interactive-pi-poc.md).

## Contributor note: Pi headless dispatch and auto-formatting

If you use `pi -p` (Pi's headless CLI mode) to make automated edits to this repository — for
example, to drive Strong Card-style agentic changes — pass `--no-autoformat`. The globally
installed `pi-lens` extension package runs Biome as an auto-formatter on every edited
`.js`/`.ts` file when the target repository has no committed `biome.json`/`.prettierrc`
(true of this repo), silently rewriting 2-space indentation to tabs and changing quote/comma
style after the edit completes — independent of which model issued the edit. This is a
harness-level behavior, not a defect in this repository's code or a model capability
limitation; `--no-autoformat` avoids it entirely.
