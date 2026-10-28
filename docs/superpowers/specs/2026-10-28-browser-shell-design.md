# In-dashboard shell — Design

## Purpose

Let the human open an interactive shell on a registered server from the dashboard, in the browser, without leaving the console and without typing a hostname or password. Today the only human path to a box is a separate terminal and a separate set of credentials; the dashboard can watch agents but cannot act.

## Intent

The daemon already does everything hard: it resolves a server-id to real connection details, holds the secrets, opens PTY shells over `ssh2`, and streams output to the dashboard over an Origin-checked WebSocket. A browser shell joins those pieces: a terminal emulator in the detail pane, a second WebSocket carrying raw bytes both ways, and the existing shell channel with real PTY dimensions. The server-id-only boundary holds: the browser sends keystrokes to the daemon by id, and only the daemon speaks SSH.

Passwords never reach the browser. When a prompt on the remote asks for one (sudo, `mysql -p`, a chained `ssh`), a **Paste password** button asks the daemon to type the stored password into the PTY itself. There is no "copy to clipboard": that would be the first path by which a Keychain secret leaves the daemon process, over an unauthenticated local API, into a store every app can read.

## Goals

- A "Shell" action on every server's detail view that opens a live terminal to that server in the detail pane, through its jump chain if it has one.
- Real PTY behaviour: colours, cursor movement, resize follows the pane, `Ctrl-C`, editors and pagers work.
- A **Paste password** button that types the server's stored password into the shell daemon-side, only when the remote is visibly at a password prompt.
- An **Open as root** variant on servers with "Allow sudo" on, which primes sudo right after the shell opens using the existing session primer.
- Every shell is a run in the audit log and the Live view, with its **output** recorded under the existing 128 KB head-and-tail cap. Keystroke frames are never recorded. The record is therefore the terminal **transcript** (the user's decision): echoed command lines are in it, passwords typed at real prompts (echo off) are not. Same as agent sessions today.
- Works offline: no CDN assets.

## Non-goals

- Keystroke recording or session replay. Output only, by the user's decision.
- Copying any secret to the clipboard or returning one in an HTTP response.
- Multiple shells to the same server in one tab, split panes, or tabs of shells. One shell at a time in the detail pane.
- File transfer, port forwarding, or SFTP.
- Reconnecting a shell across a daemon restart. The shell dies with the daemon and the UI says so.
- Dashboard authentication. Unchanged, documented trade-off; see Security.

## Anti-goals

- A stored password appearing in the terminal, the audit log, a broadcast, or the browser's memory or clipboard.
- "Paste password" typing the password as a command because the shell was not at a prompt.
- A human shell silently absent from the Live view or History while agent runs are present. Humans are watched the same way agents are.
- Breaking the agent session path (`srv session`) or the sudo feature while adding this.

## Constraints

- Depends on the sudo branch (`feature/sudo`, PR #2) for `sudoAllowed`, `hasSudoSecret`, the `:sudo` Keychain entry and `createSudoPrimer`. Build on top of it or on `main` after it merges.
- Frontend stays vanilla JS/CSS with no build step. xterm.js and its fit addon are vendored into `public/vendor/` as plain script files, pinned to a specific version, and served by the existing `express.static`.
- Follows the dashboard's rendering rules: the terminal element is created once per shell and never re-rendered while open; resize is a targeted call, not a re-render.
- Visual direction unchanged: Basalt terminal, the existing `.chip` family, JetBrains Mono inside the terminal.
- Additive SQLite migration only (`runs.kind` gains a value; see §5).
- All SSH errors shown to the browser go through `sanitizeSshError`. `SudoError` passes through unsanitized, as in the sudo feature.

## Design

### 1. Daemon: `SshManager.startShell`

A new method alongside `startSession`:

```ts
startShell(server, opts: { cols: number; rows: number; term?: string; sudoPassword?: string },
           onData: (chunk: Buffer) => void, onClose: () => void): Promise<ShellHandle>
ShellHandle = { write(data: Buffer | string): void; resize(cols, rows): void; close(): void }
```

- Opens the chain with `connectChain`, then `client.shell({ term: opts.term ?? 'xterm-256color', cols, rows })`.
- Raw bytes in both directions. No idle detection, no line handling: this is not an agent session and must not share the `session_send` machinery.
- `resize` calls the channel's `setWindow(rows, cols, 0, 0)`.
- `sudoPassword`, when given, runs the existing `createSudoPrimer` flow before the handle is returned, exactly as `startSession --sudo` does (password written only after the joined prompt sentinel, priming output suppressed, `SudoError` on failure or 15 s timeout). On `close`, `sudo -k\n` is written best-effort before the channel ends, as sessions do.
- Shell handles are tracked in a map so `close` on daemon shutdown and on WebSocket close both unwind every hop client.

### 2. Daemon: `/api/shell/:id` WebSocket

Attached in `attachWebSocket` beside `/api/live`, with the same `verifyClient` Origin check.

- On connection: query params `cols`, `rows`, and `root=1` for Open as root. Resolve the server; reject with a close frame (code 4404, reason `unknown server`) if absent. For `root=1`, reuse the sudo gate from the socket server (`sudoAllowed` off → close 4403 `sudo is not enabled for <id>`; no password resolvable → 4403 `sudo error: no sudo password stored for <id>`). Extract the gate into a shared helper so both callers use one implementation.
- Message protocol, client to daemon, JSON text frames:
  - `{ "t": "in", "d": "<string>" }` keystrokes, written to the PTY as-is.
  - `{ "t": "resize", "cols": n, "rows": n }`.
  - `{ "t": "paste_secret" }` the Paste password button; see §3.
- Daemon to client: binary frames are PTY output bytes; JSON text frames are control: `{ "t": "ready", "runId" }`, `{ "t": "toast", "msg" }` (used by the paste guard), `{ "t": "exit" }` when the remote shell ends.
- Each WebSocket owns exactly one shell. Socket close → `handle.close()` → run finished in the log. Shell close → `exit` frame → socket closed.
- Output is also fed to the audit log and broadcast on `/api/live` as `stream` events with the run's id, so the Live view shows the shell exactly like an agent run.
- A per-shell idle timeout of **4 hours** with no keystrokes closes the shell. Humans leave tabs open; agents do not. The UI shows "closed after 4 h idle".

### 3. Paste password

- The button is present on **every** server whose record has a password to paste: a `:sudo` entry (`hasSudoSecret`) or, failing that, a login password (`authMethod === 'password'`). Key-auth servers with no sudo entry do not show it. Resolution order matches the sudo feature: `:sudo` entry first, then login password. **This is deliberately not behind the "Allow sudo" switch** (the user's decision): that switch governs what *agents* may do unattended; Paste is a human at the keyboard typing a password they already own, into a shell they already opened. The cost is stated in §6.
- On `paste_secret`, the daemon checks the **prompt guard**: the last 256 bytes of PTY output, with ANSI escapes stripped, must match `/(password|passphrase)[^\r\n]{0,80}:\s*$/i`. If so it writes `<password>\r` to the PTY. If not it replies `{ "t": "toast", "msg": "The shell is not at a password prompt." }` and writes nothing. This is the same principle as the sudo-session primer: the password is never written until the remote has visibly asked for it.
- Because prompts that ask for a password turn echo off, the password does not appear in the output stream, so it does not reach the audit log or the Live broadcast. The guard exists for the case where that assumption fails: a plain `echo -n "password: "` would match the guard, and the typed secret would then be echoed.
- **Redaction backstop** (my call): the daemon knows the exact bytes it just wrote, so for 2 seconds after each paste a filter sits between the PTY and all three sinks (browser socket, audit log, Live broadcast) and replaces any occurrence of the pasted secret with `[redacted]`. This catches the echoing-prompt case. It is not a proof either (a remote `stty olcuc` or a program that re-encodes its input defeats it), and the docs say so; together with the guard it turns the anti-goal from "trust the remote" into "the remote must actively transform the echo".
- The password is written as one `write` and never retained on the socket object or logged. Keystroke frames (`in`) are never logged either.
- The password resolution happens at paste time, not at shell open, so a shell opened before the human changed the password still pastes the current one.

### 4. Frontend

- **Vendored xterm.js** (`public/vendor/xterm.js`, `xterm.css`, `xterm-addon-fit.js`), loaded from `index.html` after `app.js`'s dependencies. Pinned version recorded in a one-line `public/vendor/VERSIONS` file.
- **Server detail head** gains two actions next to Test: **Shell**, and **Shell as root** when `sudoAllowed`. Clicking either replaces the detail pane's content below the head with the shell panel: a toolbar (server id in mono, status chip: `connecting` / `live` / `closed`, **Paste password** when applicable, **Close**) and the terminal, Basalt background, full remaining height.
- The terminal is created once; `fit` runs on open and on `resize` of the pane via `ResizeObserver`, each sending a `resize` frame. The pane is never re-rendered while the shell is open. Leaving the server (picking another row, switching view, or starting a draft) closes the shell after a confirm when it is `live`.
- Below 1000 px the shell lives in the detail pane like everything else; the back button closes it with the same confirm.
- Server-sent `toast` frames use the existing toast. `exit` and socket close flip the status chip to `closed` and leave the terminal content visible until Close.
- **Live view and History** show shell runs with kind label "Browser shell", agent chip `dashboard`, and the usual badges. The Live row's "pick" opens the run detail (read-only output), not the shell.

### 5. Audit log

- `runs.kind` CHECK constraint currently allows `exec` and `session`. SQLite cannot alter a CHECK in place; the migration recreates the table with `kind IN ('exec','session','shell')` once, guarded by `user_version = 2`, copying rows and recreating both indexes. `RunKind` gains `'shell'`.
- A shell run: `agentLabel: 'dashboard'`, `command: null`, `sudo: true` when opened as root, output appended as it streams (capped), finished with `exitCode: null` on close.
- The refused Open as root attempt is logged like a refused sudo run, so History shows it.

### 6. Security

- Same trust boundary as the rest of the dashboard: bound to `127.0.0.1`, Origin-checked WebSocket, no auth. The Origin check defeats cross-site WebSocket hijacking from other pages in the browser; it does not stop a local non-browser process, which can already run `srv exec` on any server. The new surface for such a process is an interactive PTY and the Paste button. The Paste guard means it cannot pull the password out by sending `paste_secret` into an echoing shell, unless it first prints a fake prompt itself, which it can. **So: a local process that can reach the dashboard can obtain the stored password through this feature**, where today it can only run commands. This is a real widening and the reason the earlier no-auth decision should be revisited in the same breath. The spec proceeds under the documented trade-off; the mitigation options are the same as for the sudo self-enable gap: local auth on the dashboard, or a per-shell confirm that only the dashboard page can produce (not available without auth), or audit rows for every `paste_secret` with the guard's verdict. The last one is in scope: **every `paste_secret` request is logged as an audit row** (`kind: 'exec'`, `command: 'paste_secret'`, output = `accepted` or `refused: not at a prompt`), so misuse is at least visible.
- Keystrokes are not logged. Output is, under the cap.

### 7. CLI complement (optional, not in this spec's deliverable)

`srv shell <id>` in Terminal.app via the same `startShell` would be a small follow-on once the daemon side exists. Left out of this spec's scope.

## Open to the builder

- xterm.js version and whether the fit addon or a manual cols/rows calculation is used.
- Exact WebSocket close codes beyond 4403/4404, and whether `ready` carries the PTY size.
- How the shell panel is composed in `app.js` (a `renderShell()` targeted render like `renderHops`, with the terminal node held outside `state`).
- Where the shared sudo gate helper lives (`src/daemon/sudo.ts` is the natural home).
- ANSI-stripping regex for the prompt guard.

## Testing expectations

- `ssh-manager`: `startShell` passes cols/rows/term to `client.shell`; `resize` calls `setWindow`; `close` unwinds hops; `sudoPassword` runs the primer and `sudo -k` on close.
- `dashboard-server`: WebSocket `/api/shell/:id` rejects a bad Origin, an unknown id, and `root=1` on a server with sudo off (4403 with the exact message); `in` frames reach the PTY; output bytes reach the socket, the log store and the live broadcast; `paste_secret` writes `<password>\r` only when the tail matches the guard, otherwise sends a toast and writes nothing; both outcomes are audit rows; socket close closes the shell and finishes the run.
- `dashboard-server` redaction: after `paste_secret` is accepted, PTY output containing the secret within 2 s reaches the socket, the log and the broadcast as `[redacted]`; the same bytes after the window pass through unchanged; output that does not contain the secret is untouched.
- `sudo`: prompt-guard function unit tests: `[sudo] password for u: `, `Password: `, `Enter passphrase for key: `, a prompt with ANSI colour codes, a prompt followed by one trailing space; negatives: `$ `, `password: x\n`, output ending in a newline.
- `logstore`: migration recreates the table with the new CHECK, preserves rows and `user_version`, and accepts `kind: 'shell'`.
- Frontend: manual checklist (open, type, resize, paste at a sudo prompt, paste at a plain prompt → toast, close, navigate away → confirm, daemon restart → `closed`).
