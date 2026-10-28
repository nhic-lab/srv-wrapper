# In-dashboard shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Shell" (and "Shell as root") action on each server's detail that opens a live xterm.js terminal to that server through the daemon, with a daemon-side "Paste password" button, recorded in the audit log as a transcript.

**Architecture:** `SshManager.startShell` opens a raw PTY channel; a new `/api/shell/:id` WebSocket (`src/daemon/shell-server.ts`) owns one shell per socket, feeds output to the browser, the log store and the Live broadcast through a short-lived redaction filter after each paste. The frontend mounts a vendored xterm.js into the detail pane and never re-renders it while open.

**Tech Stack:** TypeScript, Node, `ssh2`, `ws`, better-sqlite3, vitest, vanilla JS, `@xterm/xterm` 6.0.0 + `@xterm/addon-fit` 0.11.0 vendored into `public/vendor/`.

**Spec:** `docs/superpowers/specs/2026-10-28-browser-shell-design.md` (branch `feature/browser-shell`, stacked on `feature/sudo`).

## Global Constraints

- Keystroke (`in`) frames are never written to the log store or broadcast. Output is, under the existing 128 KB cap.
- Secrets never leave the daemon: no HTTP response and no WebSocket frame ever carries a password.
- Paste writes `<password>\r` only when `isPasswordPrompt(tail)` is true on the last 256 bytes of ANSI-stripped output; otherwise a toast frame and no write. Every paste request becomes an audit row (`kind: 'exec'`, `command: 'paste_secret'`, exit 0 accepted / 1 refused).
- Redaction window after an accepted paste: 2000 ms; replacement text `[redacted]`.
- Idle timeout on keystrokes: 4 hours (`SHELL_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000`).
- WebSocket close codes: 4404 `unknown server`, 4403 sudo refusals (exact messages from the sudo feature), 4408 `closed after 4 h idle`, 4500 sanitized SSH error.
- Shell run rows: `kind: 'shell'`, `agentLabel: 'dashboard'`, `command: null`, `sudo: true` when opened as root.
- Frontend: terminal mounted once; `renderDetail()` must not rebuild the server detail while a shell to the selected server is open.
- Additive migrations only, except the one-time table recreation for the `kind` CHECK (`user_version = 2`).
- Commits: no co-author line (user rule).

## Review Focus

1. Multi-byte UTF-8 output split across SSH chunks must render correctly in the browser → test in Task 5 (redactor passes Buffers through unchanged when no secret) and Task 7 frontend uses `term.write(Uint8Array)` which handles split sequences itself.
2. A paste secret split across two output chunks must still be redacted → test in Task 3.
3. A browser tab closing mid-command must close the SSH shell and finish the run → test in Task 5.
4. A `/api/shell/:id` upgrade for an id with a jump chain must connect through the chain → covered by `connectChain` reuse; test in Task 4 asserts `startShell` uses `connectChain` (hop client count).
5. A second dashboard tab watching Live must see the shell's output but never its keystrokes → test in Task 5 (broadcast assertions).

---

### Task 1: `shell` run kind

**Files:**
- Modify: `src/shared/types.ts` (`RunKind = 'exec' | 'session' | 'shell'`)
- Modify: `src/daemon/logstore.ts`
- Test: `test/daemon/logstore.test.ts`

**Interfaces:**
- Produces: `LogStore.start({ kind: 'shell', … })` accepted; existing databases migrated once.

- [ ] **Step 1: Write the failing tests**

```ts
it('accepts kind "shell"', () => {
  store.start({ id: 's1', serverId: 's', agentLabel: 'dashboard', kind: 'shell', command: null })
  expect(store.get('s1')!.kind).toBe('shell')
})

it('migrates a database whose CHECK constraint predates kind "shell", keeping rows and indexes', () => {
  store.start({ id: 'old-1', serverId: 's', agentLabel: 'a', kind: 'exec', command: 'x' })
  store.appendOutput('old-1', 'kept')
  store['db'].pragma('user_version = 1')
  // rebuild the old shape: same columns, CHECK without 'shell'
  store['db'].exec(`CREATE TABLE runs_old AS SELECT * FROM runs; DROP TABLE runs;
    CREATE TABLE runs (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, agent_label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('exec','session')), command TEXT, output TEXT NOT NULL DEFAULT '',
      exit_code INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
      output_bytes INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, sudo INTEGER NOT NULL DEFAULT 0);
    INSERT INTO runs SELECT id, server_id, agent_label, kind, command, output, exit_code, started_at, ended_at, output_bytes, truncated, sudo FROM runs_old;
    DROP TABLE runs_old;`)
  store.close()
  const reopened = new LogStore(dbPath)
  try {
    expect(reopened.get('old-1')).toMatchObject({ output: 'kept', kind: 'exec' })
    expect(() => reopened.start({ id: 's1', serverId: 's', agentLabel: 'dashboard', kind: 'shell', command: null })).not.toThrow()
    expect(reopened['db'].pragma('user_version', { simple: true })).toBe(2)
    const idx = reopened['db'].prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'`).all().map((r: any) => r.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_runs_started_at', 'idx_runs_server_started']))
  } finally { reopened.close(); store = new LogStore(dbPath) }
})
```

- [ ] **Step 2: Run** `npx vitest run test/daemon/logstore.test.ts` — Expected: FAIL (CHECK constraint failed / user_version 1).

- [ ] **Step 3: Implement** — `CREATE TABLE IF NOT EXISTS` gets `CHECK(kind IN ('exec','session','shell'))`. After the existing `user_version < 1` block: if `user_version < 2`, inside a transaction, `CREATE TABLE runs_new (…full current schema…)`, `INSERT INTO runs_new SELECT … FROM runs`, `DROP TABLE runs`, `ALTER TABLE runs_new RENAME TO runs`, then set `user_version = 2`. The index creation that follows already uses `IF NOT EXISTS`, so it recreates them. `start`'s `kind` type becomes `RunKind`.

- [ ] **Step 4: Run** the file — PASS. `npx tsc -p tsconfig.json --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/daemon/logstore.ts test/daemon/logstore.test.ts
git commit -m "Add the shell run kind with a one-time CHECK migration"
```

---

### Task 2: Shared sudo gate and password-prompt guard

**Files:**
- Modify: `src/daemon/sudo.ts`
- Modify: `src/daemon/socket-server.ts` (`resolveSudo` delegates to the shared gate)
- Test: `test/daemon/sudo.test.ts`, `test/daemon/socket-server.test.ts` (existing sudo tests must stay green)

**Interfaces:**
- Produces:
```ts
export function gateSudo(server: ServerRecord, resolve: ((s: ServerRecord) => string | undefined) | undefined): string | { refusal: string }
export function stripAnsi(s: string): string
export function isPasswordPrompt(tail: string): boolean   // on the ANSI-stripped tail
export const PASSWORD_PROMPT = /(password|passphrase)[^\r\n]{0,80}:\s*$/i
```
`gateSudo` reproduces `SocketServer.resolveSudo` exactly (including the try/catch around `resolve` and the two refusal messages).

- [ ] **Step 1: Write the failing tests**

```ts
describe('isPasswordPrompt', () => {
  it.each([
    '[sudo] password for deploy: ', 'Password: ', 'Enter passphrase for key \'/home/u/.ssh/id\': ',
    '\x1b[1;32mPassword:\x1b[0m ', 'root@box password:',
  ])('accepts %j', (s) => expect(isPasswordPrompt(stripAnsi(s))).toBe(true))
  it.each(['$ ', 'password: x\n', 'Password:\n', 'ls -la\nuser@host:~$ ', ''])('rejects %j', (s) => expect(isPasswordPrompt(stripAnsi(s))).toBe(false))
})

describe('gateSudo', () => {
  const srv = (o: Partial<ServerRecord>): ServerRecord => ({ id: 's', host: 'h', port: 22, username: 'u', authMethod: 'password', createdAt: 0, updatedAt: 0, ...o })
  it('refuses when sudo is off', () => expect(gateSudo(srv({}), () => 'p')).toEqual({ refusal: 'sudo is not enabled for s' }))
  it('refuses when nothing resolves or the resolver throws', () => {
    expect(gateSudo(srv({ sudoAllowed: true }), () => undefined)).toEqual({ refusal: 'sudo error: no sudo password stored for s' })
    expect(gateSudo(srv({ sudoAllowed: true }), () => { throw new Error('x') })).toEqual({ refusal: 'sudo error: no sudo password stored for s' })
  })
  it('returns the password otherwise', () => expect(gateSudo(srv({ sudoAllowed: true }), () => 'p')).toBe('p'))
})
```

- [ ] **Step 2: Run** `npx vitest run test/daemon/sudo.test.ts` — FAIL (not exported).

- [ ] **Step 3: Implement** in `sudo.ts`; make `SocketServer.resolveSudo` a one-line delegate to `gateSudo(server, this.opts.resolveSudoSecret)`.

- [ ] **Step 4: Run** `npx vitest run test/daemon/sudo.test.ts test/daemon/socket-server.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/sudo.ts src/daemon/socket-server.ts test/daemon/sudo.test.ts
git commit -m "Share the sudo gate and add the password-prompt guard"
```

---

### Task 3: Redactor

**Files:**
- Create: `src/daemon/redact.ts`
- Test: `test/daemon/redact.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Redactor { filter(chunk: Buffer): Buffer; flush(): Buffer; readonly active: boolean }
export function createRedactor(secret: string, windowMs: number, now?: () => number): Redactor
```
Semantics: for `windowMs` after creation, every occurrence of `secret` (UTF-8 bytes) in the stream is replaced by `[redacted]`. To catch a secret split across chunks, `filter` holds back up to `secret.length - 1` trailing bytes that are a prefix of the secret; `flush()` returns held bytes (call it when the window ends or the stream closes). After the window, `filter` returns input unchanged and `active` is false. An empty secret never redacts.

- [ ] **Step 1: Write the failing tests**

```ts
it('replaces the secret inside the window and passes other bytes through', () => {
  const r = createRedactor('hunter2', 2000, () => 0)
  expect(r.filter(Buffer.from('ok hunter2 done\n')).toString()).toBe('ok [redacted] done\n')
  expect(r.filter(Buffer.from('plain\n')).toString()).toBe('plain\n')
})
it('redacts a secret split across two chunks', () => {
  const r = createRedactor('hunter2', 2000, () => 0)
  const a = r.filter(Buffer.from('x hun'))
  const b = r.filter(Buffer.from('ter2 y'))
  expect(a.toString() + b.toString()).toBe('x [redacted] y')
})
it('releases held-back bytes on flush when they were not the secret', () => {
  const r = createRedactor('hunter2', 2000, () => 0)
  expect(r.filter(Buffer.from('ab hun')).toString()).toBe('ab ')
  expect(r.flush().toString()).toBe('hun')
})
it('is inert after the window', () => {
  let t = 0
  const r = createRedactor('hunter2', 2000, () => t)
  t = 2001
  expect(r.active).toBe(false)
  expect(r.filter(Buffer.from('hunter2')).toString()).toBe('hunter2')
})
it('never redacts with an empty secret', () => {
  expect(createRedactor('', 2000).filter(Buffer.from('abc')).toString()).toBe('abc')
})
```

- [ ] **Step 2: Run** `npx vitest run test/daemon/redact.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `src/daemon/redact.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add src/daemon/redact.ts test/daemon/redact.test.ts
git commit -m "Add a windowed output redactor for pasted secrets"
```

---

### Task 4: `SshManager.startShell`

**Files:**
- Modify: `src/daemon/ssh-manager.ts`
- Test: `test/daemon/ssh-manager.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ShellHandle { write(data: string | Buffer): void; resize(cols: number, rows: number): void; close(): void }
startShell(server: ServerRecord, opts: { cols: number; rows: number; term?: string; sudoPassword?: string },
           onData: (chunk: Buffer) => void, onClose: () => void): Promise<ShellHandle>
```
- Calls `client.shell({ term: opts.term ?? 'xterm-256color', cols, rows }, cb)`. `resize` → `channel.setWindow(rows, cols, 0, 0)`. `close` → (if primed: `write('sudo -k\n')` best-effort) `channel.end()`, `closeChainClients`. Channel `close` event → `onClose()` once, then unwind. `sudoPassword` reuses `primeSudo` with `(s) => onData(Buffer.from(s))`; on failure the chain is closed and the `SudoError` rethrown. Handles are tracked in `private shells = new Set<ShellHandle>()`; `closeAllShells()` for tests/shutdown.

- [ ] **Step 1: Write the failing tests** (fake client has `shell: vi.fn((opts, cb) => cb(null, channel))` with the two-arg signature; channel has `write`, `end`, `setWindow` spies)

```ts
it('startShell opens a PTY with the requested size and term, forwards output as Buffers, resizes via setWindow, and closes hops', …)
  // expect(fakeClient.shell.mock.calls[0][0]).toEqual({ term: 'xterm-256color', cols: 120, rows: 40 })
  // channel.emit('data', Buffer.from([0xe2, 0x9c])) → onData received that exact Buffer
  // handle.resize(100, 30) → setWindow(30, 100, 0, 0); handle.write('ls\r') → channel.write('ls\r')
  // handle.close() → channel.end + fakeClient.end
it('startShell calls onClose once when the remote shell ends, and unwinds the chain', …)
it('startShell with sudoPassword primes sudo first and writes sudo -k on close', …)   // reuse the fakeShell helper from the session priming tests
it('startShell through a jump chain opens the shell on the last hop only', …)       // two-hop registry like the existing chain tests; shell called once on the last client
```

- [ ] **Step 2: Run** — FAIL (startShell undefined).
- [ ] **Step 3: Implement.** Note the existing `client.shell(cb)` one-arg call in `startSession` is unchanged.
- [ ] **Step 4: Run** `npx vitest run test/daemon/ssh-manager.test.ts` — PASS.
- [ ] **Step 5: Commit**

```bash
git add src/daemon/ssh-manager.ts test/daemon/ssh-manager.test.ts
git commit -m "Add SshManager.startShell for raw PTY shells"
```

---

### Task 5: Shell WebSocket server and upgrade routing

**Files:**
- Create: `src/daemon/shell-server.ts`
- Modify: `src/daemon/dashboard-server.ts` (`DashboardOptions.resolveSudoSecret?`, `attachWebSocket` with `noServer` routing for `/api/live` and `/api/shell/:id`)
- Modify: `src/daemon/index.ts` (wire `resolveSudoSecret` into the dashboard too; define the resolver once and pass it to both servers)
- Test: `test/daemon/shell-server.test.ts`, `test/daemon/dashboard-server.test.ts` (existing `/api/live` Origin test stays green)

**Interfaces:**
- Consumes: `startShell` (Task 4), `gateSudo`, `isPasswordPrompt`, `stripAnsi` (Task 2), `createRedactor` (Task 3), `LogStore.start({ kind: 'shell' })` (Task 1).
- Produces:
```ts
export interface ShellServerOptions { registry; logStore; sshManager; resolveSudoSecret?: (s: ServerRecord) => string | undefined; broadcast: (event: object) => void }
export function handleShellConnection(ws: WebSocket, serverId: string, query: URLSearchParams, opts: ShellServerOptions): void
```
Protocol exactly as the spec §2 and §3: client JSON `{t:'in',d}`, `{t:'resize',cols,rows}`, `{t:'paste_secret'}`; daemon binary frames = output, JSON `{t:'ready',runId}`, `{t:'toast',msg}`, `{t:'exit'}`. Output path per chunk: `redactor?.filter(chunk)` → `ws.send(buf, { binary: true })`, `logStore.appendOutput(runId, buf.toString())`, `broadcast({ type:'stream', requestId: runId, stream:'stdout', chunk: buf.toString(), serverId, agentLabel:'dashboard', sudo })`. Keep the last 256 bytes of ANSI-stripped output in a ring for the prompt guard. Paste: resolve the password at paste time via `opts.resolveSudoSecret?.(server)` (the sudo resolver already implements `:sudo` first, then login password); `undefined` → toast `No password is stored for this server.` Audit row per paste. Accepted paste: `handle.write(password + '\r')`, `redactor = createRedactor(password, 2000)`; when the window lapses or the shell closes, `flush()` output goes through the same three sinks. Idle timer reset on `in` frames; expiry → close 4408. Socket close → `handle.close()`, `logStore.finish(runId, null)`, broadcast `done`. Shell `onClose` → send `{t:'exit'}`, close socket 1000, finish run.
- `attachWebSocket` becomes `new WebSocketServer({ noServer: true, verifyClient })` plus `server.on('upgrade', …)` that parses `req.url`, routes `/api/live` to the existing client set and `/api/shell/<id>` (id matching `/^[a-zA-Z0-9._-]{1,64}$/`) to `handleShellConnection`, and destroys the socket for any other path.

- [ ] **Step 1: Write the failing tests** (spin up `http.createServer(app)`, `attachWebSocket`, connect with `ws` and `Origin: http://127.0.0.1:4280`; the `SshManager` gets a fake `connectFn` whose client has a `shell(opts, cb)` giving an `EventEmitter` channel with `write`/`end`/`setWindow` spies)

```ts
it('rejects a bad Origin, an unknown id (4404) and a malformed path', …)
it('opens a shell with the query cols/rows, sends ready with a run id, relays output as binary frames, logs it and broadcasts it as agent "dashboard"', …)
it('never logs or broadcasts keystrokes: an "in" frame reaches the PTY only', …)
it('resize frames call setWindow', …)
it('closing the socket closes the shell and finishes the run; the shell ending sends exit and closes the socket', …)
it('root=1 on a server with sudo off closes 4403 with "sudo is not enabled for <id>" and logs a refused shell run', …)
it('root=1 primes sudo through the existing primer and marks the run sudo', …)
it('paste_secret at a password prompt writes <password>\\r, logs an accepted row, and redacts the secret from socket, log and broadcast for 2 s', …)
it('paste_secret away from a prompt writes nothing, sends a toast, and logs a refused row', …)
it('paste_secret with no resolvable password sends a toast and writes nothing', …)
it('closes 4408 after the idle timeout with no keystrokes', …)   // vi.useFakeTimers
```

- [ ] **Step 2: Run** `npx vitest run test/daemon/shell-server.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** `shell-server.ts`, the upgrade routing, and the `index.ts` wiring.
- [ ] **Step 4: Run** `npx vitest run test/daemon/shell-server.test.ts test/daemon/dashboard-server.test.ts` — PASS; `npx tsc -p tsconfig.json --noEmit` — clean.
- [ ] **Step 5: Commit**

```bash
git add src/daemon/shell-server.ts src/daemon/dashboard-server.ts src/daemon/index.ts test/daemon/shell-server.test.ts test/daemon/dashboard-server.test.ts
git commit -m "Add the /api/shell WebSocket with paste guard, redaction and audit"
```

---

### Task 6: Vendor xterm.js

**Files:**
- Modify: `package.json` (devDependencies `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`; script `"vendor": "node scripts/vendor-xterm.mjs"`)
- Create: `scripts/vendor-xterm.mjs` (copies `node_modules/@xterm/xterm/lib/xterm.js`, `node_modules/@xterm/xterm/css/xterm.css`, `node_modules/@xterm/addon-fit/lib/addon-fit.js` into `public/vendor/` and writes `public/vendor/VERSIONS` with the two package versions read from their `package.json`)
- Create: `public/vendor/*` (committed output of the script)
- Modify: `public/index.html` (`<link rel="stylesheet" href="/vendor/xterm.css">` in head; `<script src="/vendor/xterm.js">` and `<script src="/vendor/addon-fit.js">` before `/app.js`)

No unit test. Verification is the script running and the files being served.

- [ ] **Step 1:** `npm install --save-dev @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0`
- [ ] **Step 2:** Write the script and run `npm run vendor`. Expected: three files plus `VERSIONS` in `public/vendor/`, `VERSIONS` reads `@xterm/xterm 6.0.0` / `@xterm/addon-fit 0.11.0`.
- [ ] **Step 3:** Edit `index.html`. Verify with `node -e` that the three paths exist and that `index.html` references them.
- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json scripts/vendor-xterm.mjs public/vendor public/index.html
git commit -m "Vendor xterm.js and the fit addon for the dashboard shell"
```

---

### Task 7: Frontend shell panel

**Files:**
- Modify: `public/app.js`, `public/styles.css`

No automated tests; syntax check with `node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"`. Manual checklist in the spec.

- [ ] **Step 1: State.** `state.shell = null | { serverId, root, ws, term, fit, status: 'connecting'|'live'|'closed', runId, observer }`. A module-level `shellHost` element holds the mounted terminal so it survives re-renders of its parent only through the guard in Step 4.
- [ ] **Step 2: Actions.** In `renderServerDetail`'s head (not for drafts): `btn-plain#srv-shell` "Shell", and `btn-plain#srv-shell-root` "Shell as root" when `s.sudoAllowed`; both disabled while a shell to this server is open. Handlers call `openShell(s.id, { root })`.
- [ ] **Step 3: `openShell(serverId, { root })`.** Builds the panel markup into `#detail` *below the head* (toolbar: mono server id, `#shell-status` chip, `#shell-paste` "Paste password" when `s.hasSudoSecret || s.authMethod === 'password'`, `#shell-close` "Close"; then `#shell-term`), creates `new Terminal({ theme: {background: '#17211B', …}, fontFamily: 'JetBrains Mono', fontSize: 13, cursorBlink: true })`, loads `FitAddon`, `term.open(host)`, `fit.fit()`, opens `ws://<location.host>/api/shell/<id>?cols=&rows=&root=1?`, `ws.binaryType = 'arraybuffer'`. `onmessage`: ArrayBuffer → `term.write(new Uint8Array(data))`; string → JSON control (`ready` → status live; `toast` → `toast(msg, 'fail')`; `exit` → status closed). `term.onData(d => ws.send(JSON.stringify({t:'in', d})))`. `ResizeObserver` on the host → `fit.fit()` then `{t:'resize', cols: term.cols, rows: term.rows}`. `ws.onclose` → status closed, chip text from the close reason when present. Paste button → `{t:'paste_secret'}`. Close → `closeShell()`.
- [ ] **Step 4: Guards.** At the top of `renderDetail()`: if `state.shell && state.view === 'servers' && state.selServer === state.shell.serverId && !state.draft` → return without touching the DOM. `switchView`, the server row `pick`, `startDraft`, and the pane back button call `leaveShell()` first: if `state.shell.status === 'live'` and `!window.confirm('Close the shell to <id>?')` → abort the navigation; else `closeShell()`.
- [ ] **Step 5: Run rows.** Live and History: `kindLabel` becomes `'Browser shell'` for `kind === 'shell'` (live runs: `run.kind` from `newRun(msg)` where the broadcast now carries `kind`; add `kind` to the stream/done broadcasts in Task 5's shell server, and default `'exec'`/`'session'` by `command` presence as today); `agent-chip` shows `dashboard`.
- [ ] **Step 6: Styles.** `.shell-panel { display:flex; flex-direction:column; height: calc(100% - …) }`, `.shell-toolbar` reusing `.srv-head` spacing, `.chip.connecting`/`.chip.live` reuse `testing`/`ok` tones, `#shell-term { flex:1; min-height: 320px; background: var(--basalt) }`. Mobile: the panel fills the detail pane.
- [ ] **Step 7: Syntax check and commit**

```bash
node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"
git add public/app.js public/styles.css
git commit -m "Dashboard: in-browser shell panel with paste password"
```

---

### Task 8: Docs, version, full verification

**Files:**
- Modify: `CLAUDE.md` (a paragraph on the shell: raw PTY path separate from agent sessions, the paste guard and redactor are leak guards with tests, keystrokes never logged, transcript recorded)
- Modify: `package.json` version `0.5.0`
- Modify: `.claude/skills/srv-wrapper/SKILL.md` (one line under "Everything you run is watched": the human may be in a browser shell on the same box; agents don't need to do anything differently)

- [ ] **Step 1:** Edit the three files.
- [ ] **Step 2: Run** `npm test && npx tsc -p tsconfig.json --noEmit && npm run build` — all green.
- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md package.json .claude/skills/srv-wrapper/SKILL.md
git commit -m "Document the browser shell and bump to 0.5.0"
```
