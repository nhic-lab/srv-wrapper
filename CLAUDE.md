# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                                   # install dependencies
npm run build                                 # compile TypeScript (src/ -> dist/)
npm test                                       # run full test suite (vitest run)
npx vitest run test/daemon/registry.test.ts   # run a single test file
npx tsc -p tsconfig.json --noEmit             # typecheck without emitting
npm run dev:daemon                             # run the daemon in dev mode (tsx, no build step)
```

There is no lint script configured.

To test the CLI against a real daemon:
```bash
node dist/cli/index.js exec <server-id> "<command>" --agent <label>
npm link                                       # exposes `srv`/`srvd` globally (see package.json bin)
```

`scripts/install-launchd.sh` installs a launchd agent that runs the *built* daemon (`dist/daemon/index.js`) and auto-starts it on login — this is a persistent system-level change outside the project directory; never run it without the user's explicit go-ahead. It reads `scripts/com.srv-wrapper.daemon.plist` as a template.

## Architecture

This is a local daemon + CLI that lets AI agents run commands on registered servers by an opaque `server-id` only — the CLI process and any agent using it never see the real hostname, port, username, or credentials. Full design rationale lives in `docs/superpowers/specs/2026-08-01-ssh-wrapper-design.md`; the implementation plan (useful for understanding why files are split the way they are) is in `docs/superpowers/plans/2026-08-01-ssh-wrapper.md`.

**Single daemon process** (`src/daemon/index.ts` is the wiring entry point — read it first when tracing how anything connects): constructs `Registry` (SQLite server metadata), `Keychain` (macOS `security` CLI wrapper for secrets, Keychain-ACL-trusted to this script's own resolved path via `fs.realpathSync(process.argv[1])` — trusting `process.execPath`/`node` itself would over-broaden that trust to every script run via that Node install, so don't "simplify" this), `LogStore` (SQLite audit history of every exec/session), `SshManager` (wraps `ssh2` for exec + PTY sessions, with TOFU host-key pinning persisted via `RegistryHostKeyStore`), and wires them into two local-only network surfaces:

- **`SocketServer`** (`src/daemon/socket-server.ts`) — a Unix domain socket (`~/.srv/srv.sock`, 0600 permissions) speaking a tiny newline-delimited-JSON protocol (`src/daemon/socket-protocol.ts`). This is what the `srv` CLI (`src/cli/client.ts` + `src/cli/index.ts`) talks to. Handles both one-shot `exec` and persistent `session_start`/`session_send`/`session_stop` — sessions are tracked in an in-memory `Map` keyed by session id, with two independent timers per session (a ~300ms per-`session_send` idle-detection timer deciding when a single send's output is done streaming, and a 30-minute session-timeout timer that auto-closes an abandoned session, reset on every `session_send`).
- **Dashboard** (`src/daemon/dashboard-server.ts` + static files in `public/`) — Express + `ws`, bound to `127.0.0.1` only, no auth layer (an explicit, reconfirmed design trade-off — do not add auth without the user's sign-off; there is a documented rejection of that suggestion). Handles server registration (single + bulk JSON, with rollback-safe Keychain/registry writes — see the multi-round fix history in git log around `dashboard-server.ts` if touching this), history queries, and broadcasts live exec/session output over WebSocket (Origin-checked in `attachWebSocket`).

**SSH errors are sanitized before they ever reach the CLI or the audit log** (`sanitizeSshError` in `src/daemon/socket-server.ts`) — raw Node/ssh2 connection errors routinely embed the real host:port, which would violate the server-id-only boundary. The daemon's own stderr (`~/.srv/daemon.error.log` under launchd) still gets the raw error for debugging; never route raw SSH error messages to a client-facing field without going through this sanitizer.

**Key-based SSH auth** reads the private key file from `server.keyPath`, restricted to paths that resolve (via `fs.realpathSync`, which also defeats symlink escapes) inside `~/.ssh` — see `readPrivateKeyFile` in `src/daemon/ssh-manager.ts`. This is a deliberate boundary; don't widen it without cause.

**Frontend** (`public/index.html`, `app.js`, `styles.css`) is vanilla JS/CSS with no build step, served directly via `express.static` — edits take effect on refresh, no daemon restart needed. Visual direction is monochrome/Geist-based (near-black background, hairline borders instead of solid gray blocks, status color as the only non-gray accent) — see the spec's "Visual Direction" section before changing styling.

**Test doubles**: `SshManager` takes an injectable `connectFn` (defaults to a real `ssh2`-backed `defaultConnect`) and `hostKeyStore`, `Keychain` takes an injectable `exec` function wrapping `spawnSync` — all daemon-side tests construct real `Registry`/`LogStore` instances against temp SQLite files (not mocked) but fake the SSH/Keychain boundary this way. Follow this pattern rather than mocking the SQLite layer.
