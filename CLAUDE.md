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

**Frontend** (`public/index.html`, `app.js`, `styles.css`) is vanilla JS/CSS with no build step, served directly via `express.static` — edits take effect on refresh, no daemon restart needed.

The UI is a **two-region list/detail shell**: a dark Canopy command bar (brand, view tabs carrying the running count, connection state, ⌘K) over a fixed two-column body — list left (404px), detail right. Selection is the core interaction in all three views: pick a row on the left, read it on the right. Below 1000px it collapses to one column and the panes swap via `#app[data-pane]`, with a back button. Implements the `Srv Console B.dc.html` prototype in the Claude Design project "Admin dashboard redesign project"; that project's `dev-notes.md` is the authoritative brief for intent.

Visual direction is the light **Innovative VAS** system: Hillmist `#F3F6F4` canvas, white panels, Basalt `#17211B` terminals, Tea Field `#0B6B4D` as the only action colour, Sunbird `#E8A33D` sparingly (tab underline, the layered stack behind the edit card, focus rings), facet cuts (top-left + bottom-right) on cards/buttons/chips via the `.facet-8/14/24` classes, near-rectangular 2px inputs, one imigongo strip under the command bar. Type: Archivo headings/overlines, IBM Plex Sans UI copy, JetBrains Mono for every id, host, command, timestamp and log line. Icons are inline Lucide SVG.

**Output is capped at write time** (`src/daemon/logstore.ts`, 128 KB head + 128 KB tail + an elision marker). A handful of `mysqldump`/`docker exec` runs had reached ~97 MB each and held 96% of a 1.8 GB `log.db`, which made `GET /api/history` fail outright with `RangeError: Invalid string length` once the combined output passed V8's ~512 MB string ceiling. The cap also removes a quadratic write cost — `output = output || chunk` rewrites the whole column on every chunk. Once a run passes the cap, `LogStore` holds its head/tail in memory and stops touching the `output` column until `finish()`. `scripts/compact-log.mjs` (`npm run compact-log`, needs `--yes`, daemon stopped) retro-fits the same cap onto pre-existing rows and VACUUMs.

**History is paginated and output is fetched per run.** `GET /api/history` returns *metadata only* — never `output` — newest first, honouring `limit`/`offset`, with the total row count in the `X-Total-Count` header. `GET /api/history/:id` returns one run including its (already capped) output. Do not put `output` back into the list response; that is precisely what broke. `LogStore.list()` therefore returns `RunSummary`, not `RunRecord` — use `get()` when you need output. A history *refresh* re-reads the whole loaded window rather than page one, otherwise a finishing run would silently discard pages the user had loaded.

**Reachability is persisted** in the registry (`last_test_at` / `last_test_ok` / `last_test_error`, additive migrations like `host_key_fingerprint`). With 50+ servers an in-memory-only map meant re-running "Test all" after every refresh. `registry.upsert` lists its columns explicitly, so editing a server does not clobber these — there is a test for that. The stored error is the already-sanitized message; never persist a raw ssh2/Node error.

**Theming**: light is the default, `:root[data-theme="dark"]` overrides the tokens, an inline script in `index.html` resolves the theme before first paint, and the choice follows the system until the user picks explicitly. One rule matters more than the rest: `--white`, `--basalt` and `--hillmist` **invert** between themes, so they must never be used as text sitting on a coloured fill. Use the non-inverting `--on-canopy` / `--on-sunbird` / `--on-tea` / `--danger-fill` tokens for that, `--tea` for Tea Field *fills*, and `--tea-text` for Tea Field as *text or an indicator dot*. Ignoring this produced light-on-amber (1.8:1) and dark-on-green (3.4:1) in dark mode. Secondary text (`--muted-2`) and the terminal gutter are slightly darker/lighter than the prototype's hex values because the originals measured 2.2–3.1:1 at 11–13px; all text now passes WCAG AA in both themes.

Two rendering rules that matter when editing `app.js`:
- **The list and the detail re-render independently**, and the detail's terminal is *never* re-rendered while a run streams — `ingest()` returns DOM ops that `applyTermOps()` appends in place. Rebuilding it would drop scroll position and flicker on every chunk.
- **Form inputs update state without re-rendering** (only hops/auth-method do targeted updates), so typing never loses focus.

Overlays (palette, confirm) are centred by a `.overlay` wrapper, *not* by a transform: the `pop` keyframe ends on `transform: none`, which cancels translate-based centring and throws the panel off-screen.

**Test doubles**: `SshManager` takes an injectable `connectFn` (defaults to a real `ssh2`-backed `defaultConnect`) and `hostKeyStore`, `Keychain` takes an injectable `exec` function wrapping `spawnSync` — all daemon-side tests construct real `Registry`/`LogStore` instances against temp SQLite files (not mocked) but fake the SSH/Keychain boundary this way. Follow this pattern rather than mocking the SQLite layer.
