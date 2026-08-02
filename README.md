# srv-wrapper

A local daemon + CLI that lets AI coding agents run commands on your servers by an opaque **server-id** only — the agent never sees the real hostname, IP, port, username, or password/key. Everything an agent runs is visible live in a browser dashboard and permanently recorded in an audit log.

## Why

Giving an AI agent real SSH credentials means it can (accidentally or otherwise) leak them, and you lose visibility into what it actually did on the remote box. `srv-wrapper` sits between the agent and your servers: you register a server once via the dashboard, the agent only ever gets a short id like `srv-a1`, and the daemon resolves that id to the real connection internally.

## How it works

- **`srvd`** — a background daemon that holds the server registry (SQLite), stores secrets in the macOS Keychain, manages SSH connections, and exposes two local-only surfaces:
  - a Unix domain socket for the CLI
  - an Express + WebSocket dashboard, bound to `127.0.0.1` only
- **`srv`** — the CLI an agent invokes. Supports one-shot commands and persistent interactive sessions.
- **Dashboard** — register servers (single or bulk JSON import), watch a live feed of what every agent is running right now, and browse history.

## Install

```bash
npm install
npm run build
npm link              # exposes `srv` and `srvd` globally
```

Then, to have the daemon start automatically on login:

```bash
./scripts/install-launchd.sh
```

This installs a `launchd` agent (`~/Library/LaunchAgents/com.srv-wrapper.daemon.plist`) that runs the built daemon and restarts it if it crashes. Logs go to `~/.srv/daemon.log` and `~/.srv/daemon.error.log`.

Alternatively, run it directly without installing anything permanent:

```bash
npm run dev:daemon
```

## Usage

Open the dashboard at **http://127.0.0.1:4280** and register a server (id, host, port, username, auth method, password or key passphrase).

Then, from anywhere:

```bash
# one-shot command
srv exec srv-a1 "npm run build" --agent my-agent-label

# persistent session (state — cwd, env vars — persists across calls)
srv session start srv-a1 --agent my-agent-label   # prints a session id
srv session send <session-id> "cd /var/www && ls"
srv session send <session-id> "pwd"                # still /var/www
srv session stop <session-id>
```

`--agent <label>` is required on every `exec` and `session start` call — it's how the dashboard's live view distinguishes multiple agents running at once.

A Claude Code skill (`.claude/skills/srv-wrapper/SKILL.md`, also symlinked into `~/.claude/skills/`) documents this CLI so any Claude Code agent picks it up automatically.

## Security model

- Servers are referenced everywhere only by id — real connection details never reach the CLI process, its output, or the audit log (SSH errors are sanitized before being surfaced).
- Secrets live in the macOS Keychain, scoped to the daemon binary via an ACL — not in the SQLite registry.
- SSH host keys are pinned on first use (TOFU) and persisted across daemon restarts.
- Private key files are restricted to paths resolving inside `~/.ssh`.
- The dashboard has no authentication layer — it's a deliberate trade-off for a tool that only binds to `127.0.0.1` on your own machine, not a gap.

## Development

See `CLAUDE.md` for commands and architecture notes. Full design spec and implementation plan live under `docs/superpowers/`.
