# SSH Wrapper for AI Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local daemon + CLI + dashboard that lets AI agents run commands on registered servers by opaque `server-id` only (never host/port/user/secret), with a live browser dashboard and persistent audit log.

**Architecture:** A single Node.js/TypeScript daemon (`srvd`) holds SQLite-backed registry + log storage, macOS-Keychain-backed secrets, and an `ssh2`-based connection manager. It exposes two local-only surfaces: a Unix domain socket (newline-delimited JSON protocol) for the `srv` CLI, and an Express+`ws` HTTP server (127.0.0.1-only) serving the dashboard UI/API and broadcasting live activity over WebSocket. CLI and dashboard never see real connection details — only `server-id`.

**Tech Stack:** TypeScript, Node.js, `ssh2` (SSH/PTY), `better-sqlite3` (registry + log store), `express` + `ws` (dashboard), `commander` (CLI), macOS `security` CLI (Keychain), `vitest` (tests).

## Global Constraints

- Servers are referenced everywhere (CLI args, dashboard UI, logs) only by `server-id` — real host/port/username/secret must never reach the CLI process or its output.
- Every exec/session call requires `--agent <label>` — no default/inferred label.
- Dashboard binds to `127.0.0.1` only, no auth layer (localhost-only trust model).
- Full shell access once connected via server-id — no command allowlist/denylist in v1.
- Multiple concurrent execs/sessions per server-id are allowed (no single-session lock).
- Deleting a server blocks new execs/sessions against that id immediately but does not force-close already-open sessions.
- Visual direction for the dashboard: monochrome brutalist (Geist-based) — true-black background, Geist Sans/Geist Mono, status color as only accent, hairline borders (not solid gray blocks) for separation, 6/10-12/14px radii. See `docs/superpowers/specs/2026-08-01-ssh-wrapper-design.md` "Visual Direction" section for full detail — Task 8 implements this exactly.

---

## Task 1: Project Scaffolding & Shared Types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/shared/types.ts`
- Create: `src/shared/paths.ts`
- Test: `test/shared/paths.test.ts`

**Interfaces:**
- Produces: `ServerRecord` `{ id: string; host: string; port: number; username: string; authMethod: 'password' | 'key'; keyPath?: string; createdAt: number; updatedAt: number }`
- Produces: `RunRecord` `{ id: string; serverId: string; agentLabel: string; kind: 'exec' | 'session'; command: string | null; output: string; exitCode: number | null; startedAt: number; endedAt: number | null }`
- Produces: `srvHome(): string` returning `~/.srv`, and `srvSocketPath(): string`, `srvRegistryDbPath(): string`, `srvLogDbPath(): string`, `srvKeysDir(): string`.

- [ ] **Step 1: Initialize package.json and install dependencies**

```bash
cd ~/Documents/Code/node/srv-wrapper
npm init -y
npm install ssh2 better-sqlite3 express ws commander
npm install -D typescript vitest @types/node @types/express @types/ws @types/better-sqlite3 tsx
```

Edit `package.json` to add:
```json
{
  "name": "srv-wrapper",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "srv": "./dist/cli/index.js",
    "srvd": "./dist/daemon/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "dev:daemon": "tsx src/daemon/index.ts"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Write shared types**

`src/shared/types.ts`:
```typescript
export type AuthMethod = 'password' | 'key'

export interface ServerRecord {
  id: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  createdAt: number
  updatedAt: number
}

export type RunKind = 'exec' | 'session'

export interface RunRecord {
  id: string
  serverId: string
  agentLabel: string
  kind: RunKind
  command: string | null
  output: string
  exitCode: number | null
  startedAt: number
  endedAt: number | null
}

export interface ExecRequest {
  type: 'exec'
  serverId: string
  agentLabel: string
  command: string
}

export interface SessionStartRequest {
  type: 'session_start'
  serverId: string
  agentLabel: string
}

export interface SessionSendRequest {
  type: 'session_send'
  sessionId: string
  command: string
}

export interface SessionStopRequest {
  type: 'session_stop'
  sessionId: string
}

export type DaemonRequest =
  | ExecRequest
  | SessionStartRequest
  | SessionSendRequest
  | SessionStopRequest

export interface StreamEvent {
  type: 'stream'
  requestId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface DoneEvent {
  type: 'done'
  requestId: string
  exitCode: number | null
  error?: string
}

export interface SessionStartedEvent {
  type: 'session_started'
  requestId: string
  sessionId: string
}

export type DaemonEvent = StreamEvent | DoneEvent | SessionStartedEvent
```

- [ ] **Step 5: Write the failing test for paths**

`test/shared/paths.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath, srvKeysDir } from '../../src/shared/paths.js'
import { homedir } from 'node:os'
import path from 'node:path'

describe('paths', () => {
  it('srvHome resolves to ~/.srv', () => {
    expect(srvHome()).toBe(path.join(homedir(), '.srv'))
  })

  it('srvSocketPath resolves inside srvHome', () => {
    expect(srvSocketPath()).toBe(path.join(srvHome(), 'srv.sock'))
  })

  it('srvRegistryDbPath and srvLogDbPath are distinct files inside srvHome', () => {
    expect(srvRegistryDbPath()).toBe(path.join(srvHome(), 'registry.db'))
    expect(srvLogDbPath()).toBe(path.join(srvHome(), 'log.db'))
  })

  it('srvKeysDir resolves inside srvHome', () => {
    expect(srvKeysDir()).toBe(path.join(srvHome(), 'keys'))
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/shared/paths.test.ts`
Expected: FAIL — `src/shared/paths.ts` does not exist yet.

- [ ] **Step 7: Implement paths.ts**

`src/shared/paths.ts`:
```typescript
import { homedir } from 'node:os'
import path from 'node:path'

export function srvHome(): string {
  return path.join(homedir(), '.srv')
}

export function srvSocketPath(): string {
  return path.join(srvHome(), 'srv.sock')
}

export function srvRegistryDbPath(): string {
  return path.join(srvHome(), 'registry.db')
}

export function srvLogDbPath(): string {
  return path.join(srvHome(), 'log.db')
}

export function srvKeysDir(): string {
  return path.join(srvHome(), 'keys')
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/shared/paths.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/shared test
git commit -m "Scaffold project, add shared types and path helpers"
```

---

## Task 2: Registry & Secrets Storage

**Files:**
- Create: `src/daemon/registry.ts`
- Create: `src/daemon/keychain.ts`
- Test: `test/daemon/registry.test.ts`
- Test: `test/daemon/keychain.test.ts`

**Interfaces:**
- Consumes: `ServerRecord` from `src/shared/types.ts`, `srvRegistryDbPath()` from `src/shared/paths.ts`.
- Produces: `class Registry` with `constructor(dbPath: string)`, `upsert(record: Omit<ServerRecord,'createdAt'|'updatedAt'>): ServerRecord`, `get(id: string): ServerRecord | undefined`, `list(): ServerRecord[]`, `delete(id: string): void`, `close(): void`.
- Produces: `class Keychain` with `constructor(daemonBinaryPath: string)`, `setSecret(serverId: string, secret: string): void`, `getSecret(serverId: string): string`, `deleteSecret(serverId: string): void`. Internally shells out to macOS `security` CLI via an injectable `exec` function (for testability).

- [ ] **Step 1: Write the failing test for Registry**

`test/daemon/registry.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Registry } from '../../src/daemon/registry.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dbPath: string
let registry: Registry

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-test-')), 'registry.db')
  registry = new Registry(dbPath)
})

afterEach(() => {
  registry.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

describe('Registry', () => {
  it('upsert inserts a new server and stamps timestamps', () => {
    const rec = registry.upsert({ id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy', authMethod: 'password' })
    expect(rec.id).toBe('srv-a1')
    expect(rec.createdAt).toBeGreaterThan(0)
    expect(rec.updatedAt).toBe(rec.createdAt)
  })

  it('get returns the stored record by id', () => {
    registry.upsert({ id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy', authMethod: 'password' })
    const rec = registry.get('srv-a1')
    expect(rec?.host).toBe('10.0.0.5')
  })

  it('get returns undefined for unknown id', () => {
    expect(registry.get('nope')).toBeUndefined()
  })

  it('list returns all registered servers', () => {
    registry.upsert({ id: 'srv-a1', host: 'a', port: 22, username: 'u', authMethod: 'password' })
    registry.upsert({ id: 'srv-b7', host: 'b', port: 2222, username: 'u2', authMethod: 'key', keyPath: '/x/y' })
    const all = registry.list()
    expect(all.map((r) => r.id).sort()).toEqual(['srv-a1', 'srv-b7'])
  })

  it('upsert on existing id updates fields and bumps updatedAt without changing createdAt', () => {
    const first = registry.upsert({ id: 'srv-a1', host: 'a', port: 22, username: 'u', authMethod: 'password' })
    const second = registry.upsert({ id: 'srv-a1', host: 'a-new-alias', port: 22, username: 'u', authMethod: 'password' })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.host).toBe('a-new-alias')
  })

  it('delete removes the record', () => {
    registry.upsert({ id: 'srv-a1', host: 'a', port: 22, username: 'u', authMethod: 'password' })
    registry.delete('srv-a1')
    expect(registry.get('srv-a1')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/registry.test.ts`
Expected: FAIL — `src/daemon/registry.ts` does not exist.

- [ ] **Step 3: Implement Registry**

`src/daemon/registry.ts`:
```typescript
import Database from 'better-sqlite3'
import type { ServerRecord } from '../shared/types.js'

export class Registry {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL CHECK(auth_method IN ('password','key')),
        key_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
  }

  upsert(record: Omit<ServerRecord, 'createdAt' | 'updatedAt'>): ServerRecord {
    const now = Date.now()
    const existing = this.get(record.id)
    const createdAt = existing?.createdAt ?? now

    this.db
      .prepare(
        `INSERT INTO servers (id, host, port, username, auth_method, key_path, created_at, updated_at)
         VALUES (@id, @host, @port, @username, @authMethod, @keyPath, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           host=excluded.host, port=excluded.port, username=excluded.username,
           auth_method=excluded.auth_method, key_path=excluded.key_path, updated_at=excluded.updated_at`
      )
      .run({
        id: record.id,
        host: record.host,
        port: record.port,
        username: record.username,
        authMethod: record.authMethod,
        keyPath: record.keyPath ?? null,
        createdAt,
        updatedAt: now,
      })

    return this.get(record.id)!
  }

  get(id: string): ServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any
    if (!row) return undefined
    return {
      id: row.id,
      host: row.host,
      port: row.port,
      username: row.username,
      authMethod: row.auth_method,
      keyPath: row.key_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  list(): ServerRecord[] {
    const rows = this.db.prepare('SELECT id FROM servers ORDER BY id').all() as { id: string }[]
    return rows.map((r) => this.get(r.id)!)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id)
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/registry.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing test for Keychain**

`test/daemon/keychain.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { Keychain } from '../../src/daemon/keychain.js'

describe('Keychain', () => {
  it('setSecret shells out to security add-generic-password with the daemon binary as trusted app', () => {
    const runs: string[][] = []
    const fakeExec = (cmd: string, args: string[]) => {
      runs.push([cmd, ...args])
      return { stdout: '', status: 0 }
    }
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    kc.setSecret('srv-a1', 'hunter2')

    expect(runs[0][0]).toBe('security')
    expect(runs[0]).toContain('add-generic-password')
    expect(runs[0]).toContain('-a')
    expect(runs[0]).toContain('srv-a1')
    expect(runs[0]).toContain('-s')
    expect(runs[0]).toContain('srv-wrapper')
    expect(runs[0]).toContain('-w')
    expect(runs[0]).toContain('hunter2')
    expect(runs[0]).toContain('-T')
    expect(runs[0]).toContain('/usr/local/bin/srvd')
    expect(runs[0]).toContain('-U')
  })

  it('getSecret shells out to security find-generic-password and returns trimmed stdout', () => {
    const fakeExec = vi.fn().mockReturnValue({ stdout: 'hunter2\n', status: 0 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    const secret = kc.getSecret('srv-a1')

    expect(secret).toBe('hunter2')
    const args = fakeExec.mock.calls[0][1] as string[]
    expect(fakeExec.mock.calls[0][0]).toBe('security')
    expect(args).toContain('find-generic-password')
    expect(args).toContain('-w')
  })

  it('getSecret throws if the underlying command reports non-zero status', () => {
    const fakeExec = () => ({ stdout: '', status: 44 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    expect(() => kc.getSecret('missing')).toThrow()
  })

  it('deleteSecret shells out to security delete-generic-password', () => {
    const fakeExec = vi.fn().mockReturnValue({ stdout: '', status: 0 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    kc.deleteSecret('srv-a1')

    const args = fakeExec.mock.calls[0][1] as string[]
    expect(args).toContain('delete-generic-password')
    expect(args).toContain('srv-a1')
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/daemon/keychain.test.ts`
Expected: FAIL — `src/daemon/keychain.ts` does not exist.

- [ ] **Step 7: Implement Keychain**

`src/daemon/keychain.ts`:
```typescript
import { spawnSync } from 'node:child_process'

const SERVICE = 'srv-wrapper'

export type ExecFn = (cmd: string, args: string[]) => { stdout: string; status: number }

function defaultExec(cmd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' })
  return { stdout: result.stdout ?? '', status: result.status ?? 1 }
}

export class Keychain {
  constructor(
    private daemonBinaryPath: string,
    private exec: ExecFn = defaultExec
  ) {}

  setSecret(serverId: string, secret: string): void {
    const result = this.exec('security', [
      'add-generic-password',
      '-a', serverId,
      '-s', SERVICE,
      '-w', secret,
      '-T', this.daemonBinaryPath,
      '-U',
    ])
    if (result.status !== 0) {
      throw new Error(`Failed to store secret for ${serverId} in Keychain (status ${result.status})`)
    }
  }

  getSecret(serverId: string): string {
    const result = this.exec('security', [
      'find-generic-password',
      '-a', serverId,
      '-s', SERVICE,
      '-w',
    ])
    if (result.status !== 0) {
      throw new Error(`No secret found for ${serverId} in Keychain (status ${result.status})`)
    }
    return result.stdout.trim()
  }

  deleteSecret(serverId: string): void {
    this.exec('security', [
      'delete-generic-password',
      '-a', serverId,
      '-s', SERVICE,
    ])
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/daemon/keychain.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Commit**

```bash
git add src/daemon/registry.ts src/daemon/keychain.ts test/daemon/registry.test.ts test/daemon/keychain.test.ts
git commit -m "Add SQLite server registry and macOS Keychain secret storage"
```

---

## Task 3: Log Store (Audit History)

**Files:**
- Create: `src/daemon/logstore.ts`
- Test: `test/daemon/logstore.test.ts`

**Interfaces:**
- Consumes: `RunRecord` from `src/shared/types.ts`.
- Produces: `class LogStore` with `constructor(dbPath: string)`, `start(input: { id: string; serverId: string; agentLabel: string; kind: 'exec' | 'session'; command: string | null }): void`, `appendOutput(id: string, chunk: string): void`, `finish(id: string, exitCode: number | null): void`, `get(id: string): RunRecord | undefined`, `list(filter?: { serverId?: string; agentLabel?: string }): RunRecord[]`, `close(): void`.

- [ ] **Step 1: Write the failing test**

`test/daemon/logstore.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LogStore } from '../../src/daemon/logstore.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dbPath: string
let store: LogStore

beforeEach(() => {
  dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-log-test-')), 'log.db')
  store = new LogStore(dbPath)
})

afterEach(() => {
  store.close()
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
})

describe('LogStore', () => {
  it('start creates a run record with empty output and no exit code', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'claude-a', kind: 'exec', command: 'ls -la' })
    const rec = store.get('run-1')
    expect(rec?.output).toBe('')
    expect(rec?.exitCode).toBeNull()
    expect(rec?.endedAt).toBeNull()
  })

  it('appendOutput accumulates chunks in order', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'claude-a', kind: 'exec', command: 'ls' })
    store.appendOutput('run-1', 'file1\n')
    store.appendOutput('run-1', 'file2\n')
    expect(store.get('run-1')?.output).toBe('file1\nfile2\n')
  })

  it('finish sets exitCode and endedAt', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'claude-a', kind: 'exec', command: 'ls' })
    store.finish('run-1', 0)
    const rec = store.get('run-1')
    expect(rec?.exitCode).toBe(0)
    expect(rec?.endedAt).toBeGreaterThan(0)
  })

  it('list filters by serverId', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'x' })
    store.start({ id: 'run-2', serverId: 'srv-b7', agentLabel: 'a', kind: 'exec', command: 'y' })
    expect(store.list({ serverId: 'srv-a1' }).map((r) => r.id)).toEqual(['run-1'])
  })

  it('list filters by agentLabel', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'agent-x', kind: 'exec', command: 'x' })
    store.start({ id: 'run-2', serverId: 'srv-a1', agentLabel: 'agent-y', kind: 'exec', command: 'y' })
    expect(store.list({ agentLabel: 'agent-y' }).map((r) => r.id)).toEqual(['run-2'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/logstore.test.ts`
Expected: FAIL — `src/daemon/logstore.ts` does not exist.

- [ ] **Step 3: Implement LogStore**

`src/daemon/logstore.ts`:
```typescript
import Database from 'better-sqlite3'
import type { RunRecord } from '../shared/types.js'

export class LogStore {
  private db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        agent_label TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('exec','session')),
        command TEXT,
        output TEXT NOT NULL DEFAULT '',
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )
    `)
  }

  start(input: { id: string; serverId: string; agentLabel: string; kind: 'exec' | 'session'; command: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, server_id, agent_label, kind, command, output, exit_code, started_at, ended_at)
         VALUES (@id, @serverId, @agentLabel, @kind, @command, '', NULL, @startedAt, NULL)`
      )
      .run({ ...input, startedAt: Date.now() })
  }

  appendOutput(id: string, chunk: string): void {
    this.db.prepare('UPDATE runs SET output = output || @chunk WHERE id = @id').run({ id, chunk })
  }

  finish(id: string, exitCode: number | null): void {
    this.db
      .prepare('UPDATE runs SET exit_code = @exitCode, ended_at = @endedAt WHERE id = @id')
      .run({ id, exitCode, endedAt: Date.now() })
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any
    if (!row) return undefined
    return this.rowToRecord(row)
  }

  list(filter?: { serverId?: string; agentLabel?: string }): RunRecord[] {
    let query = 'SELECT * FROM runs'
    const clauses: string[] = []
    const params: Record<string, string> = {}
    if (filter?.serverId) {
      clauses.push('server_id = @serverId')
      params.serverId = filter.serverId
    }
    if (filter?.agentLabel) {
      clauses.push('agent_label = @agentLabel')
      params.agentLabel = filter.agentLabel
    }
    if (clauses.length) query += ' WHERE ' + clauses.join(' AND ')
    query += ' ORDER BY started_at ASC'
    const rows = this.db.prepare(query).all(params) as any[]
    return rows.map((r) => this.rowToRecord(r))
  }

  private rowToRecord(row: any): RunRecord {
    return {
      id: row.id,
      serverId: row.server_id,
      agentLabel: row.agent_label,
      kind: row.kind,
      command: row.command,
      output: row.output,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/logstore.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/logstore.ts test/daemon/logstore.test.ts
git commit -m "Add SQLite log store for exec/session audit history"
```

---

## Task 4: SSH Manager (Exec + Sessions)

**Files:**
- Create: `src/daemon/ssh-manager.ts`
- Test: `test/daemon/ssh-manager.test.ts`

**Interfaces:**
- Consumes: `ServerRecord` from `src/shared/types.ts`; a secret-resolver function `(serverId: string) => string` (backed by `Keychain.getSecret` in production).
- Produces: `class SshManager` with `constructor(secretResolver: (serverId: string) => string, connectFn?: ConnectFn)`, `exec(server: ServerRecord, command: string, onData: (stream: 'stdout' | 'stderr', chunk: string) => void): Promise<number>`, `startSession(server: ServerRecord, onData: (chunk: string) => void): Promise<string>` (returns `sessionId`), `sendToSession(sessionId: string, command: string): void`, `stopSession(sessionId: string): void`.
- Uses an injectable `ConnectFn = (server: ServerRecord, secret: string) => Promise<FakeableClient>` so tests never touch a real network or the real `ssh2` library.

- [ ] **Step 1: Write the failing test**

`test/daemon/ssh-manager.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { SshManager } from '../../src/daemon/ssh-manager.js'
import type { ServerRecord } from '../../src/shared/types.js'
import { EventEmitter } from 'node:events'

const server: ServerRecord = {
  id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy',
  authMethod: 'password', createdAt: 0, updatedAt: 0,
}

function fakeExecChannel() {
  const channel = new EventEmitter() as any
  channel.stderr = new EventEmitter()
  return channel
}

describe('SshManager', () => {
  it('exec resolves the secret, connects, runs the command, and resolves with the exit code', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('hello\n'))
          channel.emit('close', 0)
        })
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const resolver = vi.fn().mockReturnValue('hunter2')
    const mgr = new SshManager(resolver, connectFn as any)

    const chunks: string[] = []
    const exitCode = await mgr.exec(server, 'ls -la', (_s, chunk) => chunks.push(chunk))

    expect(resolver).toHaveBeenCalledWith('srv-a1')
    expect(connectFn).toHaveBeenCalledWith(server, 'hunter2')
    expect(chunks).toEqual(['hello\n'])
    expect(exitCode).toBe(0)
  })

  it('exec forwards stderr chunks on the "stderr" stream', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.stderr.emit('data', Buffer.from('warn: thing\n'))
          channel.emit('close', 1)
        })
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const events: Array<[string, string]> = []
    const exitCode = await mgr.exec(server, 'false', (s, chunk) => events.push([s, chunk]))

    expect(events).toEqual([['stderr', 'warn: thing\n']])
    expect(exitCode).toBe(1)
  })

  it('startSession connects and returns a session id; sendToSession writes to the channel', async () => {
    const channel = fakeExecChannel()
    channel.write = vi.fn()
    const fakeClient = {
      shell: vi.fn((cb: (err: any, channel: any) => void) => cb(null, channel)),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const sessionId = await mgr.startSession(server, () => {})
    expect(typeof sessionId).toBe('string')

    mgr.sendToSession(sessionId, 'echo hi\n')
    expect(channel.write).toHaveBeenCalledWith('echo hi\n')
  })

  it('stopSession ends the channel and prevents further sendToSession calls', async () => {
    const channel = fakeExecChannel()
    channel.write = vi.fn()
    channel.end = vi.fn()
    const fakeClient = { shell: vi.fn((cb: (err: any, channel: any) => void) => cb(null, channel)) }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const sessionId = await mgr.startSession(server, () => {})
    mgr.stopSession(sessionId)
    expect(channel.end).toHaveBeenCalled()
    expect(() => mgr.sendToSession(sessionId, 'x')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/ssh-manager.test.ts`
Expected: FAIL — `src/daemon/ssh-manager.ts` does not exist.

- [ ] **Step 3: Implement SshManager**

`src/daemon/ssh-manager.ts`:
```typescript
import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { ServerRecord } from '../shared/types.js'

export type ConnectFn = (server: ServerRecord, secret: string) => Promise<any>

function defaultConnect(server: ServerRecord, secret: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    const authOpts: Record<string, unknown> =
      server.authMethod === 'password' ? { password: secret } : { privateKey: secret }
    client.connect({ host: server.host, port: server.port, username: server.username, ...authOpts })
  })
}

interface OpenSession {
  channel: any
  closed: boolean
}

export class SshManager {
  private sessions = new Map<string, OpenSession>()

  constructor(
    private secretResolver: (serverId: string) => string,
    private connectFn: ConnectFn = defaultConnect
  ) {}

  async exec(
    server: ServerRecord,
    command: string,
    onData: (stream: 'stdout' | 'stderr', chunk: string) => void
  ): Promise<number> {
    const secret = this.secretResolver(server.id)
    const client = await this.connectFn(server, secret)

    return new Promise((resolve, reject) => {
      client.exec(command, (err: any, channel: any) => {
        if (err) return reject(err)
        channel.on('data', (data: Buffer) => onData('stdout', data.toString()))
        channel.stderr.on('data', (data: Buffer) => onData('stderr', data.toString()))
        channel.on('close', (code: number) => resolve(code))
      })
    })
  }

  async startSession(server: ServerRecord, onData: (chunk: string) => void): Promise<string> {
    const secret = this.secretResolver(server.id)
    const client = await this.connectFn(server, secret)

    const channel = await new Promise<any>((resolve, reject) => {
      client.shell((err: any, ch: any) => (err ? reject(err) : resolve(ch)))
    })
    channel.on('data', (data: Buffer) => onData(data.toString()))

    const sessionId = randomUUID()
    this.sessions.set(sessionId, { channel, closed: false })
    return sessionId
  }

  sendToSession(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) throw new Error(`No open session ${sessionId}`)
    session.channel.write(command)
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.channel.end()
    session.closed = true
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/ssh-manager.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/daemon/ssh-manager.ts test/daemon/ssh-manager.test.ts
git commit -m "Add SSH manager for exec and interactive session channels"
```

---

## Task 5: Daemon Socket Server (CLI-Facing IPC)

**Files:**
- Create: `src/daemon/socket-protocol.ts`
- Create: `src/daemon/socket-server.ts`
- Test: `test/daemon/socket-protocol.test.ts`
- Test: `test/daemon/socket-server.test.ts`

**Interfaces:**
- Consumes: `DaemonRequest`, `DaemonEvent` from `src/shared/types.ts`; `Registry`, `LogStore`, `SshManager` from Tasks 2-4.
- Produces: `encodeMessage(msg: object): string` (JSON + `\n`), `decodeMessages(buffer: string): { messages: object[]; rest: string }` (splits on newlines, tolerates partial trailing data).
- Produces: `class SocketServer` with `constructor(opts: { socketPath: string; registry: Registry; logStore: LogStore; sshManager: SshManager; onBroadcast?: (event: DaemonEvent & { requestId: string }) => void })`, `start(): Promise<void>`, `stop(): Promise<void>`. Listens on a Unix domain socket; for each connection, reads newline-delimited `DaemonRequest` JSON, looks up the server in `registry`, drives `sshManager`, records progress in `logStore`, and writes newline-delimited `DaemonEvent` JSON back on the same connection (also invoking `onBroadcast` for dashboard fan-out).

- [ ] **Step 1: Write the failing test for socket-protocol**

`test/daemon/socket-protocol.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { encodeMessage, decodeMessages } from '../../src/daemon/socket-protocol.js'

describe('socket-protocol', () => {
  it('encodeMessage serializes to JSON followed by a newline', () => {
    expect(encodeMessage({ a: 1 })).toBe('{"a":1}\n')
  })

  it('decodeMessages parses one complete message and leaves no remainder', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n')
    expect(messages).toEqual([{ a: 1 }])
    expect(rest).toBe('')
  })

  it('decodeMessages parses multiple messages arriving in one chunk', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n{"b":2}\n')
    expect(messages).toEqual([{ a: 1 }, { b: 2 }])
    expect(rest).toBe('')
  })

  it('decodeMessages holds back an incomplete trailing message', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n{"b":2')
    expect(messages).toEqual([{ a: 1 }])
    expect(rest).toBe('{"b":2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/socket-protocol.test.ts`
Expected: FAIL — `src/daemon/socket-protocol.ts` does not exist.

- [ ] **Step 3: Implement socket-protocol.ts**

`src/daemon/socket-protocol.ts`:
```typescript
export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n'
}

export function decodeMessages(buffer: string): { messages: object[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const messages = parts.filter((line) => line.length > 0).map((line) => JSON.parse(line))
  return { messages, rest }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/socket-protocol.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for SocketServer**

`test/daemon/socket-server.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SocketServer } from '../../src/daemon/socket-server.js'
import { Registry } from '../../src/daemon/registry.js'
import { LogStore } from '../../src/daemon/logstore.js'
import { SshManager } from '../../src/daemon/ssh-manager.js'
import { createConnection } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir: string
let socketPath: string
let registry: Registry
let logStore: LogStore
let sshManager: SshManager
let server: SocketServer

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-sock-test-'))
  socketPath = path.join(dir, 'srv.sock')
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password' })

  sshManager = new SshManager(
    () => 'secret',
    async () => ({
      exec: (_cmd: string, cb: (err: any, channel: any) => void) => {
        const { EventEmitter } = require('node:events')
        const channel = new EventEmitter() as any
        channel.stderr = new EventEmitter()
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('ok\n'))
          channel.emit('close', 0)
        })
      },
    })
  )

  server = new SocketServer({ socketPath, registry, logStore, sshManager })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  registry.close()
  logStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function connectAndSend(payload: object): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath)
    const received: any[] = []
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'))
    conn.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line)
        received.push(msg)
        if (msg.type === 'done') {
          conn.end()
          resolve(received)
        }
      }
    })
    conn.on('error', reject)
  })
}

describe('SocketServer', () => {
  it('handles an exec request end-to-end and streams stdout then done', async () => {
    const events = await connectAndSend({
      type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-1',
    })
    const stream = events.find((e) => e.type === 'stream')
    const done = events.find((e) => e.type === 'done')
    expect(stream.chunk).toBe('ok\n')
    expect(done.exitCode).toBe(0)
  })

  it('records the run in the log store', async () => {
    await connectAndSend({ type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-2' })
    const runs = logStore.list({ serverId: 'srv-a1' })
    expect(runs).toHaveLength(1)
    expect(runs[0].agentLabel).toBe('test-agent')
    expect(runs[0].output).toBe('ok\n')
    expect(runs[0].exitCode).toBe(0)
  })

  it('responds with a done error event for an unknown serverId, without touching sshManager', async () => {
    const events = await connectAndSend({ type: 'exec', serverId: 'nope', agentLabel: 'a', command: 'x', requestId: 'req-3' })
    const done = events.find((e) => e.type === 'done')
    expect(done.error).toMatch(/unknown server/i)
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/daemon/socket-server.test.ts`
Expected: FAIL — `src/daemon/socket-server.ts` does not exist.

- [ ] **Step 7: Implement SocketServer**

`src/daemon/socket-server.ts`:
```typescript
import net from 'node:net'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from './socket-protocol.js'
import type { Registry } from './registry.js'
import type { LogStore } from './logstore.js'
import type { SshManager } from './ssh-manager.js'
import type { DaemonEvent } from '../shared/types.js'

interface SocketServerOptions {
  socketPath: string
  registry: Registry
  logStore: LogStore
  sshManager: SshManager
  onBroadcast?: (event: DaemonEvent & { requestId: string; serverId?: string; agentLabel?: string }) => void
}

export class SocketServer {
  private server: net.Server

  constructor(private opts: SocketServerOptions) {
    this.server = net.createServer((conn) => this.handleConnection(conn))
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.opts.socketPath)) fs.unlinkSync(this.opts.socketPath)
    await new Promise<void>((resolve) => this.server.listen(this.opts.socketPath, resolve))
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (fs.existsSync(this.opts.socketPath)) fs.unlinkSync(this.opts.socketPath)
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages) this.handleMessage(conn, msg as any)
    })
  }

  private async handleMessage(conn: net.Socket, msg: any): Promise<void> {
    const requestId: string = msg.requestId ?? randomUUID()

    if (msg.type === 'exec') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }

      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'exec', command: msg.command })

      try {
        const exitCode = await this.opts.sshManager.exec(server, msg.command, (stream, chunk) => {
          this.opts.logStore.appendOutput(runId, chunk)
          const event: DaemonEvent & { requestId: string } = { type: 'stream', requestId, stream, chunk }
          this.send(conn, event)
          this.opts.onBroadcast?.({ ...event, serverId: server.id, agentLabel: msg.agentLabel })
        })
        this.opts.logStore.finish(runId, exitCode)
        const done: DaemonEvent & { requestId: string } = { type: 'done', requestId, exitCode }
        this.send(conn, done)
        this.opts.onBroadcast?.({ ...done, serverId: server.id, agentLabel: msg.agentLabel })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        this.send(conn, { type: 'done', requestId, exitCode: null, error: String(err?.message ?? err) })
      }
      return
    }

    this.send(conn, { type: 'done', requestId, exitCode: null, error: `unsupported request type: ${msg.type}` })
  }

  private send(conn: net.Socket, event: DaemonEvent & { requestId: string }): void {
    conn.write(encodeMessage(event))
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/daemon/socket-server.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add src/daemon/socket-protocol.ts src/daemon/socket-server.ts test/daemon/socket-protocol.test.ts test/daemon/socket-server.test.ts
git commit -m "Add newline-JSON socket protocol and daemon socket server for exec requests"
```

---

## Task 6: CLI Client (`srv exec`)

**Files:**
- Create: `src/cli/client.ts`
- Create: `src/cli/index.ts`
- Test: `test/cli/client.test.ts`

**Interfaces:**
- Consumes: `encodeMessage`/`decodeMessages` from `src/daemon/socket-protocol.ts` (re-used client-side too), `DaemonEvent` from `src/shared/types.ts`.
- Produces: `function execCommand(opts: { socketPath: string; serverId: string; agentLabel: string; command: string; onStream: (stream: 'stdout' | 'stderr', chunk: string) => void }): Promise<number>` — connects to the Unix socket, sends an `exec` request, forwards `stream` events to `onStream`, resolves with the exit code from `done` (rejecting if `done.error` is set).
- Produces: CLI entry `srv exec <server-id> <command> --agent <label>` in `src/cli/index.ts` using `commander`, printing streamed stdout/stderr live and exiting with the remote exit code.

- [ ] **Step 1: Write the failing test**

`test/cli/client.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execCommand } from '../../src/cli/client.js'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let socketPath: string
let server: net.Server

beforeEach(() => {
  socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-cli-test-')), 'srv.sock')
})

afterEach(() => {
  server?.close()
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true })
})

function startFakeDaemon(handler: (msg: any, write: (obj: object) => void) => void) {
  server = net.createServer((conn) => {
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        handler(JSON.parse(line), (obj) => conn.write(JSON.stringify(obj) + '\n'))
      }
    })
  })
  return new Promise<void>((resolve) => server.listen(socketPath, resolve))
}

describe('execCommand', () => {
  it('sends an exec request and resolves with the exit code after streaming output', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('exec')
      expect(msg.serverId).toBe('srv-a1')
      expect(msg.agentLabel).toBe('claude-a')
      write({ type: 'stream', requestId: msg.requestId, stream: 'stdout', chunk: 'hi\n' })
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })

    const chunks: Array<[string, string]> = []
    const exitCode = await execCommand({
      socketPath, serverId: 'srv-a1', agentLabel: 'claude-a', command: 'echo hi',
      onStream: (s, c) => chunks.push([s, c]),
    })

    expect(chunks).toEqual([['stdout', 'hi\n']])
    expect(exitCode).toBe(0)
  })

  it('rejects when the daemon reports an error in the done event', async () => {
    await startFakeDaemon((msg, write) => {
      write({ type: 'done', requestId: msg.requestId, exitCode: null, error: 'unknown server: nope' })
    })

    await expect(
      execCommand({ socketPath, serverId: 'nope', agentLabel: 'a', command: 'x', onStream: () => {} })
    ).rejects.toThrow(/unknown server/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli/client.test.ts`
Expected: FAIL — `src/cli/client.ts` does not exist.

- [ ] **Step 3: Implement client.ts**

`src/cli/client.ts`:
```typescript
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from '../daemon/socket-protocol.js'

export interface ExecCommandOptions {
  socketPath: string
  serverId: string
  agentLabel: string
  command: string
  onStream: (stream: 'stdout' | 'stderr', chunk: string) => void
}

export function execCommand(opts: ExecCommandOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''

    conn.on('connect', () => {
      conn.write(
        encodeMessage({
          type: 'exec',
          requestId,
          serverId: opts.serverId,
          agentLabel: opts.agentLabel,
          command: opts.command,
        })
      )
    })

    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'stream') {
          opts.onStream(msg.stream, msg.chunk)
        } else if (msg.type === 'done') {
          conn.end()
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg.exitCode)
        }
      }
    })

    conn.on('error', reject)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli/client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Implement the CLI entry point (manual verification, no automated test — it's a thin argv/stdout wrapper)**

`src/cli/index.ts`:
```typescript
#!/usr/bin/env node
import { Command } from 'commander'
import { execCommand } from './client.js'
import { srvSocketPath } from '../shared/paths.js'

const program = new Command()

program
  .name('srv')
  .description('Run commands on registered servers by id, without ever seeing host/credentials')

program
  .command('exec <server-id> <command>')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .action(async (serverId: string, command: string, options: { agent: string }) => {
    try {
      const exitCode = await execCommand({
        socketPath: srvSocketPath(),
        serverId,
        agentLabel: options.agent,
        command,
        onStream: (stream, chunk) => {
          (stream === 'stdout' ? process.stdout : process.stderr).write(chunk)
        },
      })
      process.exit(exitCode)
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

program.parseAsync(process.argv)
```

- [ ] **Step 6: Manually verify the CLI wires up correctly**

Run: `npx tsx src/cli/index.ts exec --help`
Expected: prints usage showing the required `--agent` option — confirms `commander` parses the command without throwing.

- [ ] **Step 7: Commit**

```bash
git add src/cli/client.ts src/cli/index.ts test/cli/client.test.ts
git commit -m "Add srv CLI exec command talking to the daemon over the Unix socket"
```

---

## Task 7: Dashboard Backend (Registration API + Live/History Feed)

**Files:**
- Create: `src/daemon/dashboard-server.ts`
- Test: `test/daemon/dashboard-server.test.ts`

**Interfaces:**
- Consumes: `Registry`, `Keychain`, `LogStore` from Tasks 2-3.
- Produces: `function createDashboardApp(opts: { registry: Registry; keychain: Keychain; logStore: LogStore }): { app: import('express').Express; broadcast: (event: object) => void }`.
  - `POST /api/servers` — body `{ id, host, port, username, authMethod, keyPath?, secret }` → upserts registry entry, stores secret in Keychain, responds `201` with the registry record (no secret echoed back).
  - `POST /api/servers/bulk` — body `{ servers: Array<same shape> }` → validates each (required fields, duplicate ids within the batch), commits only if all pass, responds with `{ succeeded: string[], failed: Array<{ id?: string, error: string }> }`.
  - `DELETE /api/servers/:id` — deletes registry entry + Keychain secret.
  - `GET /api/servers` — lists registry entries (never includes secrets).
  - `GET /api/history?serverId=&agentLabel=` — returns `logStore.list(...)`.
  - `GET /api/live` — WebSocket upgrade endpoint; every call to the returned `broadcast(event)` function is JSON-sent to all connected WS clients.

- [ ] **Step 1: Write the failing test**

`test/daemon/dashboard-server.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDashboardApp } from '../../src/daemon/dashboard-server.js'
import { Registry } from '../../src/daemon/registry.js'
import { Keychain } from '../../src/daemon/keychain.js'
import { LogStore } from '../../src/daemon/logstore.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'

let dir: string
let registry: Registry
let logStore: LogStore
let keychain: Keychain
let secretsSet: Record<string, string>

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-dash-test-'))
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  secretsSet = {}
  keychain = new Keychain('/usr/local/bin/srvd', (cmd, args) => {
    if (args.includes('add-generic-password')) {
      secretsSet[args[args.indexOf('-a') + 1]] = args[args.indexOf('-w') + 1]
      return { stdout: '', status: 0 }
    }
    if (args.includes('delete-generic-password')) {
      delete secretsSet[args[args.indexOf('-a') + 1]]
      return { stdout: '', status: 0 }
    }
    return { stdout: '', status: 1 }
  })
})

afterEach(() => {
  registry.close()
  logStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('dashboard-server', () => {
  it('POST /api/servers registers a server and stores its secret in Keychain, without echoing the secret', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy', authMethod: 'password', secret: 'hunter2' })

    expect(res.status).toBe(201)
    expect(res.body.id).toBe('srv-a1')
    expect(res.body.secret).toBeUndefined()
    expect(secretsSet['srv-a1']).toBe('hunter2')
  })

  it('GET /api/servers never includes secrets', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    await request(app).post('/api/servers').send({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' })
    const res = await request(app).get('/api/servers')
    expect(res.body[0].secret).toBeUndefined()
    expect(res.body[0].id).toBe('srv-a1')
  })

  it('POST /api/servers/bulk commits all-or-nothing on validation failure', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers/bulk')
      .send({
        servers: [
          { id: 'srv-x', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' },
          { id: 'srv-x', host: 'h2', port: 22, username: 'u2', authMethod: 'password', secret: 's2' },
        ],
      })

    expect(res.body.failed.length).toBeGreaterThan(0)
    const list = await request(app).get('/api/servers')
    expect(list.body).toHaveLength(0)
  })

  it('DELETE /api/servers/:id removes registry entry and Keychain secret', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    await request(app).post('/api/servers').send({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' })
    await request(app).delete('/api/servers/srv-a1')
    expect(registry.get('srv-a1')).toBeUndefined()
    expect(secretsSet['srv-a1']).toBeUndefined()
  })

  it('GET /api/history returns runs filtered by serverId', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    logStore.start({ id: 'r1', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'x' })
    logStore.start({ id: 'r2', serverId: 'srv-b7', agentLabel: 'a', kind: 'exec', command: 'y' })
    const res = await request(app).get('/api/history?serverId=srv-a1')
    expect(res.body.map((r: any) => r.id)).toEqual(['r1'])
  })
})
```

- [ ] **Step 2: Install supertest for HTTP-level testing**

```bash
npm install -D supertest @types/supertest
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/daemon/dashboard-server.test.ts`
Expected: FAIL — `src/daemon/dashboard-server.ts` does not exist.

- [ ] **Step 4: Implement dashboard-server.ts**

`src/daemon/dashboard-server.ts`:
```typescript
import express from 'express'
import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import type { Registry } from './registry.js'
import type { Keychain } from './keychain.js'
import type { LogStore } from './logstore.js'

interface DashboardOptions {
  registry: Registry
  keychain: Keychain
  logStore: LogStore
}

interface ServerInput {
  id: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  keyPath?: string
  secret: string
}

function validateServerInput(input: any): string | null {
  if (!input.id) return 'missing id'
  if (!input.host) return 'missing host'
  if (!input.port) return 'missing port'
  if (!input.username) return 'missing username'
  if (input.authMethod !== 'password' && input.authMethod !== 'key') return 'authMethod must be password or key'
  if (!input.secret) return 'missing secret'
  return null
}

export function createDashboardApp(opts: DashboardOptions): { app: express.Express; broadcast: (event: object) => void } {
  const app = express()
  app.use(express.json())

  const wsClients = new Set<import('ws').WebSocket>()
  const broadcast = (event: object) => {
    const payload = JSON.stringify(event)
    for (const client of wsClients) client.send(payload)
  }

  app.post('/api/servers', (req, res) => {
    const input: ServerInput = req.body
    const error = validateServerInput(input)
    if (error) return res.status(400).json({ error })

    const record = opts.registry.upsert({
      id: input.id, host: input.host, port: input.port, username: input.username,
      authMethod: input.authMethod, keyPath: input.keyPath,
    })
    opts.keychain.setSecret(input.id, input.secret)
    res.status(201).json(record)
  })

  app.post('/api/servers/bulk', (req, res) => {
    const servers: ServerInput[] = req.body.servers ?? []
    const seenIds = new Set<string>()
    const failed: Array<{ id?: string; error: string }> = []
    const valid: ServerInput[] = []

    for (const input of servers) {
      const error = validateServerInput(input)
      if (error) { failed.push({ id: input.id, error }); continue }
      if (seenIds.has(input.id)) { failed.push({ id: input.id, error: 'duplicate id in batch' }); continue }
      seenIds.add(input.id)
      valid.push(input)
    }

    if (failed.length > 0) {
      return res.json({ succeeded: [], failed })
    }

    const succeeded: string[] = []
    for (const input of valid) {
      opts.registry.upsert({
        id: input.id, host: input.host, port: input.port, username: input.username,
        authMethod: input.authMethod, keyPath: input.keyPath,
      })
      opts.keychain.setSecret(input.id, input.secret)
      succeeded.push(input.id)
    }
    res.json({ succeeded, failed: [] })
  })

  app.get('/api/servers', (_req, res) => {
    res.json(opts.registry.list())
  })

  app.delete('/api/servers/:id', (req, res) => {
    opts.registry.delete(req.params.id)
    opts.keychain.deleteSecret(req.params.id)
    res.status(204).end()
  })

  app.get('/api/history', (req, res) => {
    const { serverId, agentLabel } = req.query as { serverId?: string; agentLabel?: string }
    res.json(opts.logStore.list({ serverId, agentLabel }))
  })

  app.use(express.static(new URL('../../public', import.meta.url).pathname))

  const attachWebSocket = (server: Server) => {
    const wss = new WebSocketServer({ server, path: '/api/live' })
    wss.on('connection', (ws) => {
      wsClients.add(ws)
      ws.on('close', () => wsClients.delete(ws))
    })
  }

  ;(app as any).attachWebSocket = attachWebSocket

  return { app, broadcast }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/daemon/dashboard-server.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/daemon/dashboard-server.ts test/daemon/dashboard-server.test.ts package.json package-lock.json
git commit -m "Add dashboard backend: registration API, history API, and WebSocket live feed"
```

---

## Task 8: Dashboard Frontend (Geist-Styled UI)

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/servers`, `POST /api/servers/bulk`, `GET /api/history`, WebSocket `/api/live` from Task 7.
- Produces: static assets served by the Express app's `express.static` middleware already wired in Task 7.

This task has no automated test (it's a static UI) — verification is manual, per the "UI or frontend changes" rule: it must be exercised in an actual browser before being called done. **Do not start a dev server automatically** — ask the user to run `npm run dev:daemon` (added in Task 9) and confirm what they see.

- [ ] **Step 1: Write the HTML shell**

`public/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>srv — live agent activity</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="vmock" id="app">
    <div class="vtopbar">
      <div class="vbrand"><span class="sq"></span> srv</div>
      <div class="vnav">
        <span class="nav-item active" data-view="live">Live</span>
        <span class="nav-item" data-view="history">History</span>
        <span class="nav-item" data-view="servers">Servers</span>
      </div>
    </div>
    <div class="vbody">
      <div class="vsidebar">
        <div class="label">Servers</div>
        <div id="server-list"></div>
      </div>
      <div class="vmain">
        <section id="view-live">
          <div class="vrowhead">
            <h4>Live activity</h4>
            <span class="vpill" id="live-summary">0 running</span>
          </div>
          <div id="live-feed"></div>
        </section>

        <section id="view-history" hidden>
          <div class="vrowhead"><h4>History</h4></div>
          <div id="history-feed"></div>
        </section>

        <section id="view-servers" hidden>
          <div class="vrowhead"><h4>Register a server</h4></div>
          <form id="server-form" class="vform">
            <input name="id" placeholder="server id (e.g. srv-a1)" required />
            <input name="host" placeholder="host" required />
            <input name="port" placeholder="port" value="22" required />
            <input name="username" placeholder="username" required />
            <select name="authMethod">
              <option value="password">password</option>
              <option value="key">key</option>
            </select>
            <input name="secret" placeholder="password or key passphrase" type="password" required />
            <button type="submit">Add server</button>
          </form>

          <div class="vrowhead" style="margin-top:32px"><h4>Bulk import (JSON)</h4></div>
          <textarea id="bulk-json" class="vtextarea" placeholder='[{"id":"srv-a1","host":"...","port":22,"username":"...","authMethod":"password","secret":"..."}]'></textarea>
          <button id="bulk-submit">Import</button>
          <div id="bulk-result"></div>
        </section>
      </div>
    </div>
  </div>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the Geist-based stylesheet**

`public/styles.css`:
```css
:root {
  --bg: #000000;
  --bg-200: rgba(255,255,255,0.025);
  --alpha-hover: rgba(255,255,255,0.06);
  --alpha-active: rgba(255,255,255,0.09);
  --b-hairline: rgba(255,255,255,0.09);
  --b-hairline-strong: rgba(255,255,255,0.14);
  --t-900: #a1a1a1;
  --t-1000: #ededed;
  --green: #33c481;
  --amber: #f5a524;
  --red: #e5484d;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--t-1000);
  font-family: 'Geist', -apple-system, sans-serif;
}

.vmock { min-height: 100vh; }

.vtopbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 20px 28px; border-bottom: 1px solid var(--b-hairline);
}
.vbrand { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; }
.vbrand .sq { width: 18px; height: 18px; background: var(--t-1000); border-radius: 4px; }
.vnav { display: flex; gap: 32px; font-size: 13.5px; font-weight: 500; color: var(--t-900); }
.vnav .nav-item { cursor: pointer; }
.vnav .active { color: var(--t-1000); }

.vbody { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 61px); }
.vsidebar { border-right: 1px solid var(--b-hairline); padding: 28px 18px; }
.vsidebar .label { font-size: 11px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.06em; color: var(--t-900); padding: 6px 10px; margin-bottom: 6px; }

.vsrv { display: flex; align-items: center; gap: 10px; padding: 11px 10px; border-radius: 8px; font-size: 13.5px; font-weight: 500; font-family: 'Geist Mono', monospace; }
.vsrv:hover { background: var(--alpha-hover); }
.vdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

.vmain { padding: 28px 32px; }
.vrowhead { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.vrowhead h4 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
.vpill { font-size: 11.5px; font-weight: 500; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--b-hairline-strong); color: var(--t-900); background: var(--bg-200); }

.vcard { background: var(--bg-200); border: 1px solid var(--b-hairline); border-radius: 10px; padding: 20px 22px; margin-bottom: 16px; }
.vcard .top { display: flex; justify-content: space-between; align-items: center; font-size: 13.5px; }
.vcard .id { font-family: 'Geist Mono', monospace; font-weight: 600; letter-spacing: -0.01em; }
.vcard .agent { color: var(--t-900); font-size: 12.5px; font-weight: 400; margin-top: 8px; }

.vlog { font-family: 'Geist Mono', monospace; font-weight: 400; font-size: 12px; color: var(--t-900); margin-top: 14px; background: var(--bg); border: 1px solid var(--b-hairline); border-radius: 8px; padding: 14px 16px; line-height: 1.9; max-height: 220px; overflow-y: auto; white-space: pre-wrap; }

.status-run { color: var(--green); } .status-run::before { content: "● "; }
.status-idle { color: var(--t-900); } .status-idle::before { content: "○ "; }
.status-err { color: var(--red); } .status-err::before { content: "● "; }

.vform, .vtextarea { display: flex; flex-direction: column; gap: 12px; max-width: 420px; }
.vform input, .vform select, .vtextarea {
  background: var(--bg-200); border: 1px solid var(--b-hairline); border-radius: 8px;
  padding: 10px 12px; color: var(--t-1000); font-family: 'Geist', sans-serif; font-size: 13px;
}
.vtextarea { min-height: 140px; font-family: 'Geist Mono', monospace; width: 100%; max-width: 640px; }
button {
  background: var(--t-1000); color: #000; border: none; border-radius: 8px;
  padding: 10px 16px; font-weight: 600; font-size: 13px; cursor: pointer; width: fit-content;
}
button:hover { opacity: 0.85; }
#bulk-result { margin-top: 12px; font-family: 'Geist Mono', monospace; font-size: 12px; color: var(--t-900); }
```

- [ ] **Step 3: Write the client-side app logic**

`public/app.js`:
```javascript
const state = { servers: [], activeRuns: new Map() }

async function loadServers() {
  const res = await fetch('/api/servers')
  state.servers = await res.json()
  renderServerList()
}

function renderServerList() {
  const el = document.getElementById('server-list')
  el.innerHTML = state.servers.map((s) => {
    const hasActive = [...state.activeRuns.values()].some((r) => r.serverId === s.id)
    const dotColor = hasActive ? 'var(--green)' : 'var(--t-900)'
    return `<div class="vsrv"><span class="vdot" style="background:${dotColor}"></span> ${escapeHtml(s.id)}</div>`
  }).join('')
}

function renderLiveFeed() {
  const el = document.getElementById('live-feed')
  const runs = [...state.activeRuns.values()]
  document.getElementById('live-summary').textContent = `${runs.length} running`
  el.innerHTML = runs.map((r) => `
    <div class="vcard">
      <div class="top">
        <span class="id">${escapeHtml(r.serverId)}</span>
        <span class="status status-run">running</span>
      </div>
      <div class="agent">agent: ${escapeHtml(r.agentLabel)}</div>
      <div class="vlog">${escapeHtml(r.output)}</div>
    </div>
  `).join('') || '<p style="color:var(--t-900)">No active runs.</p>'
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function connectLiveSocket() {
  const ws = new WebSocket(`ws://${location.host}/api/live`)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'stream') {
      const run = state.activeRuns.get(msg.requestId) ?? { serverId: msg.serverId, agentLabel: msg.agentLabel, output: '' }
      run.output += msg.chunk
      state.activeRuns.set(msg.requestId, run)
    } else if (msg.type === 'done') {
      state.activeRuns.delete(msg.requestId)
    }
    renderLiveFeed()
    renderServerList()
  }
}

async function loadHistory() {
  const res = await fetch('/api/history')
  const runs = await res.json()
  document.getElementById('history-feed').innerHTML = runs.map((r) => `
    <div class="vcard">
      <div class="top">
        <span class="id">${escapeHtml(r.serverId)}</span>
        <span class="${r.exitCode === 0 ? 'status status-idle' : 'status status-err'}">${escapeHtml(r.exitCode ?? 'n/a')}</span>
      </div>
      <div class="agent">agent: ${escapeHtml(r.agentLabel)} · ${escapeHtml(r.command ?? '')}</div>
      <div class="vlog">${escapeHtml(r.output)}</div>
    </div>
  `).join('')
}

function setupNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'))
      item.classList.add('active')
      const view = item.dataset.view
      document.getElementById('view-live').hidden = view !== 'live'
      document.getElementById('view-history').hidden = view !== 'history'
      document.getElementById('view-servers').hidden = view !== 'servers'
      if (view === 'history') loadHistory()
    })
  })
}

function setupServerForm() {
  document.getElementById('server-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = new FormData(e.target)
    const payload = Object.fromEntries(form.entries())
    payload.port = Number(payload.port)
    const res = await fetch('/api/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (res.ok) { e.target.reset(); loadServers() }
  })

  document.getElementById('bulk-submit').addEventListener('click', async () => {
    const raw = document.getElementById('bulk-json').value
    let servers
    try {
      servers = JSON.parse(raw)
    } catch {
      document.getElementById('bulk-result').textContent = 'Invalid JSON'
      return
    }
    const res = await fetch('/api/servers/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }),
    })
    const result = await res.json()
    document.getElementById('bulk-result').textContent =
      `${result.succeeded.length} added, ${result.failed.length} failed` +
      (result.failed.length ? ': ' + result.failed.map((f) => `${f.id ?? '?'} (${f.error})`).join(', ') : '')
    loadServers()
  })
}

loadServers()
setupNav()
setupServerForm()
connectLiveSocket()
renderLiveFeed()
```

- [ ] **Step 4: Ask the user to manually verify in a browser**

Do not start the dev server yourself. Ask the user to run:
```bash
npm run dev:daemon
```
and open `http://127.0.0.1:4280` (port wired in Task 9). Confirm: server registration form works, bulk JSON import reports success/failure counts, and the Live view updates when an exec runs (can be checked once Task 9's daemon entrypoint is running end-to-end).

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/styles.css public/app.js
git commit -m "Add Geist-styled dashboard frontend: registration, live feed, history"
```

---

## Task 9: Daemon Entry Point & launchd Packaging

**Files:**
- Create: `src/daemon/index.ts`
- Create: `scripts/install-launchd.sh`
- Create: `scripts/com.srv-wrapper.daemon.plist`
- Test: none (process wiring + shell scripting — verified manually per steps below)

**Interfaces:**
- Consumes: `Registry`, `Keychain`, `LogStore`, `SshManager`, `SocketServer` (Tasks 2-5), `createDashboardApp` (Task 7), path helpers (Task 1).
- Produces: a runnable daemon process that starts the socket server on `srvSocketPath()` and the dashboard HTTP+WS server on `127.0.0.1:4280`, wiring `SocketServer`'s `onBroadcast` into the dashboard's `broadcast`.

- [ ] **Step 1: Write the daemon entry point**

`src/daemon/index.ts`:
```typescript
import http from 'node:http'
import fs from 'node:fs'
import { Registry } from './registry.js'
import { Keychain } from './keychain.js'
import { LogStore } from './logstore.js'
import { SshManager } from './ssh-manager.js'
import { SocketServer } from './socket-server.js'
import { createDashboardApp } from './dashboard-server.js'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath } from '../shared/paths.js'

const DASHBOARD_PORT = 4280

async function main() {
  fs.mkdirSync(srvHome(), { recursive: true })

  const registry = new Registry(srvRegistryDbPath())
  const logStore = new LogStore(srvLogDbPath())
  const keychain = new Keychain(process.argv[1] ?? 'srvd')
  const sshManager = new SshManager((serverId) => keychain.getSecret(serverId))

  const { app, broadcast } = createDashboardApp({ registry, keychain, logStore })
  const httpServer = http.createServer(app)
  ;(app as any).attachWebSocket(httpServer)
  httpServer.listen(DASHBOARD_PORT, '127.0.0.1', () => {
    console.log(`Dashboard listening on http://127.0.0.1:${DASHBOARD_PORT}`)
  })

  const socketServer = new SocketServer({
    socketPath: srvSocketPath(),
    registry,
    logStore,
    sshManager,
    onBroadcast: (event) => broadcast(event),
  })
  await socketServer.start()
  console.log(`Socket server listening on ${srvSocketPath()}`)
}

main().catch((err) => {
  console.error('srvd failed to start:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Build and manually verify the daemon starts**

Run:
```bash
npm run build
node dist/daemon/index.js
```
Expected: console prints both listening lines, process stays running (Ctrl+C to stop). This confirms all Task 1-7 modules wire together without import errors.

- [ ] **Step 3: Write the launchd plist template**

`scripts/com.srv-wrapper.daemon.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.srv-wrapper.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE_PATH__</string>
    <string>__DAEMON_DIST_PATH__</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>__SRV_HOME__/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>__SRV_HOME__/daemon.error.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Write the install script**

`scripts/install-launchd.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$(command -v node)"
DAEMON_DIST_PATH="$PROJECT_DIR/dist/daemon/index.js"
SRV_HOME="$HOME/.srv"
PLIST_DEST="$HOME/Library/LaunchAgents/com.srv-wrapper.daemon.plist"

mkdir -p "$SRV_HOME"

sed \
  -e "s#__NODE_PATH__#${NODE_PATH}#g" \
  -e "s#__DAEMON_DIST_PATH__#${DAEMON_DIST_PATH}#g" \
  -e "s#__SRV_HOME__#${SRV_HOME}#g" \
  "$PROJECT_DIR/scripts/com.srv-wrapper.daemon.plist" > "$PLIST_DEST"

launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load "$PLIST_DEST"

echo "srvd installed and loaded via launchd. Logs: $SRV_HOME/daemon.log"
```

- [ ] **Step 5: Make the install script executable**

```bash
chmod +x scripts/install-launchd.sh
```

- [ ] **Step 6: Ask the user to confirm before running the install script**

This registers a launchd agent that auto-starts on login — confirm with the user before running `scripts/install-launchd.sh`, since it's a persistent system-level change outside the project directory.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/index.ts scripts/install-launchd.sh scripts/com.srv-wrapper.daemon.plist
git commit -m "Add daemon entry point wiring all components, plus launchd packaging"
```

---

## Task 10: Persistent Session Support (SocketServer + CLI)

The spec requires both invocation modes. Tasks 5-6 only wired up one-shot `exec`; this task adds `session_start` / `session_send` / `session_stop` on top of the `SshManager.startSession`/`sendToSession`/`stopSession` methods already built in Task 4.

**Files:**
- Modify: `src/daemon/socket-server.ts` — add handling for `session_start`, `session_send`, `session_stop` request types.
- Modify: `src/cli/client.ts` — add `sessionStart`, `sessionSend`, `sessionStop` functions.
- Modify: `src/cli/index.ts` — add `srv session start/send/stop` subcommands.
- Test: `test/daemon/socket-server.test.ts` (extend) — add session-flow cases.
- Test: `test/cli/client.test.ts` (extend) — add session-flow cases.

**Interfaces:**
- Consumes: `SshManager.startSession(server, onData): Promise<string>`, `.sendToSession(sessionId, command): void`, `.stopSession(sessionId): void` (Task 4).
- Produces (socket-server side): on `session_start`, calls `sshManager.startSession`, records a `LogStore` run with `kind: 'session'`, replies with `{ type: 'session_started', requestId, sessionId }` on the connection, then closes that connection — the daemon keeps the session alive internally in a `Map<sessionId, { serverId, agentLabel, runId, pendingConn: net.Socket | null, pendingRequestId: string | null, idleTimer: NodeJS.Timeout | null, sessionTimeoutTimer: NodeJS.Timeout }>`.
- Produces: on `session_send`, writes the command to the session's channel, attaches the *current* connection as `pendingConn`, resets the 30-minute `sessionTimeoutTimer`, and forwards subsequent output chunks to it as `stream` events until 300ms of silence, then sends `{ type: 'done', requestId, exitCode: null }` and detaches `pendingConn` (chunks arriving with no `pendingConn` are still appended to the `LogStore` run's output so history stays complete).
- Produces: on `session_stop`, clears the `sessionTimeoutTimer`, calls `sshManager.stopSession(sessionId)`, finalizes the `LogStore` run (`finish(runId, null)`), removes the map entry, replies `{ type: 'done', requestId, exitCode: null }`. The same cleanup (minus the reply, since no connection is waiting) runs automatically if `sessionTimeoutTimer` fires first — per spec, idle sessions auto-close after 30 minutes of no `session_send` activity.
- Produces (CLI client side): `sessionStart(opts: { socketPath, serverId, agentLabel }): Promise<string>` (resolves with `sessionId`), `sessionSend(opts: { socketPath, sessionId, command, onStream }): Promise<void>`, `sessionStop(opts: { socketPath, sessionId }): Promise<void>`.
- Produces (CLI commands): `srv session start <server-id> --agent <label>` (prints the returned session id to stdout), `srv session send <session-id> "<command>"`, `srv session stop <session-id>`.

- [ ] **Step 1: Write the failing tests for session flow in SocketServer**

First, update the top import line of `test/daemon/socket-server.test.ts` (added in Task 5) from:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
```
to:
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
```
(the new fake-timer test below needs `vi`).

Then add to `test/daemon/socket-server.test.ts` (same file/setup as the existing `exec` tests — the `beforeEach` already provides a `sshManager` whose fake `connectFn` only implements `exec`; extend that fake to also implement `shell` for session tests):

```typescript
  it('handles a full session_start -> session_send -> session_stop flow', async () => {
    // Rebuild sshManager with both exec and shell support for this test
    const { EventEmitter } = await import('node:events')
    const channel: any = new EventEmitter()
    channel.stderr = new EventEmitter()
    channel.write = (data: string) => {
      queueMicrotask(() => channel.emit('data', Buffer.from(`echo of: ${data}`)))
    }
    channel.end = () => channel.emit('close')

    const sessionSshManager = new SshManager(
      () => 'secret',
      async () => ({ shell: (cb: (err: any, ch: any) => void) => cb(null, channel) })
    )
    await server.stop()
    server = new SocketServer({ socketPath, registry, logStore, sshManager: sessionSshManager })
    await server.start()

    const startEvents = await connectAndSend({ type: 'session_start', serverId: 'srv-a1', agentLabel: 'agent-x', requestId: 'r1' }, 'session_started')
    const sessionId = startEvents.find((e) => e.type === 'session_started').sessionId
    expect(typeof sessionId).toBe('string')

    const sendEvents = await connectAndSend({ type: 'session_send', sessionId, command: 'ls\n', requestId: 'r2' }, 'done')
    expect(sendEvents.find((e) => e.type === 'stream').chunk).toContain('echo of: ls')

    const stopEvents = await connectAndSend({ type: 'session_stop', sessionId, requestId: 'r3' }, 'done')
    expect(stopEvents.find((e) => e.type === 'done')).toBeDefined()

    const runs = logStore.list({ agentLabel: 'agent-x' })
    expect(runs).toHaveLength(1)
    expect(runs[0].kind).toBe('session')
    expect(runs[0].endedAt).not.toBeNull()
  })

  it('auto-closes a session after 30 minutes of no session_send activity', async () => {
    vi.useFakeTimers()
    try {
      const { EventEmitter } = await import('node:events')
      const channel: any = new EventEmitter()
      channel.stderr = new EventEmitter()
      channel.write = () => {}
      let ended = false
      channel.end = () => { ended = true; channel.emit('close') }

      const sessionSshManager = new SshManager(
        () => 'secret',
        async () => ({ shell: (cb: (err: any, ch: any) => void) => cb(null, channel) })
      )
      await server.stop()
      server = new SocketServer({ socketPath, registry, logStore, sshManager: sessionSshManager })
      await server.start()

      const startEvents = await connectAndSend({ type: 'session_start', serverId: 'srv-a1', agentLabel: 'agent-x', requestId: 'r1' }, 'session_started')
      const sessionId = startEvents.find((e) => e.type === 'session_started').sessionId

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000)

      expect(ended).toBe(true)
      const runs = logStore.list({ agentLabel: 'agent-x' })
      expect(runs[0].endedAt).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
```

Update the shared `connectAndSend` helper in that file to accept the event type it should resolve on (it currently hardcodes `'done'`):

```typescript
function connectAndSend(payload: object, resolveOn: string = 'done'): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath)
    const received: any[] = []
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'))
    conn.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line)
        received.push(msg)
        if (msg.type === resolveOn) {
          conn.end()
          resolve(received)
        }
      }
    })
    conn.on('error', reject)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/socket-server.test.ts`
Expected: FAIL — `SocketServer` doesn't recognize `session_start`/`session_send`/`session_stop` yet (falls through to "unsupported request type").

- [ ] **Step 3: Implement session handling in SocketServer**

Add to `src/daemon/socket-server.ts` — a new field, a new branch in `handleMessage`, and the idle-detection helpers. Two timers exist per session and serve different purposes: `idleTimer` (300ms) decides when a single `session_send` call has finished receiving output; `sessionTimeoutTimer` (30 min, reset on every `session_send`) auto-closes a session nobody is using anymore, per the spec's session-timeout requirement.

```typescript
// Add near the top of the class body, alongside `private server: net.Server`
private static readonly SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

private sessions = new Map<string, {
  serverId: string
  agentLabel: string
  runId: string
  pendingConn: net.Socket | null
  pendingRequestId: string | null
  idleTimer: NodeJS.Timeout | null
  sessionTimeoutTimer: NodeJS.Timeout
}>()
```

Insert into `handleMessage`, before the final fallback `send(conn, { type: 'done', ... unsupported ... })`:

```typescript
    if (msg.type === 'session_start') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }
      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'session', command: null })

      const sessionId = await this.opts.sshManager.startSession(server, (chunk) => {
        this.opts.logStore.appendOutput(runId, chunk)
        const session = this.sessions.get(sessionId)
        if (session?.pendingConn && session.pendingRequestId) {
          this.send(session.pendingConn, { type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk })
          this.opts.onBroadcast?.({ type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk, serverId: server.id, agentLabel: msg.agentLabel })
          if (session.idleTimer) clearTimeout(session.idleTimer)
          session.idleTimer = setTimeout(() => this.finalizePendingSend(sessionId), 300)
        }
      })

      this.sessions.set(sessionId, {
        serverId: server.id, agentLabel: msg.agentLabel, runId,
        pendingConn: null, pendingRequestId: null, idleTimer: null,
        sessionTimeoutTimer: this.scheduleSessionTimeout(sessionId),
      })
      this.send(conn, { type: 'session_started', requestId, sessionId })
      return
    }

    if (msg.type === 'session_send') {
      const session = this.sessions.get(msg.sessionId)
      if (!session) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown session: ${msg.sessionId}` })
        return
      }
      session.pendingConn = conn
      session.pendingRequestId = requestId
      clearTimeout(session.sessionTimeoutTimer)
      session.sessionTimeoutTimer = this.scheduleSessionTimeout(msg.sessionId)
      this.opts.sshManager.sendToSession(msg.sessionId, msg.command)
      session.idleTimer = setTimeout(() => this.finalizePendingSend(msg.sessionId), 300)
      return
    }

    if (msg.type === 'session_stop') {
      const session = this.sessions.get(msg.sessionId)
      if (!session) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown session: ${msg.sessionId}` })
        return
      }
      clearTimeout(session.sessionTimeoutTimer)
      this.opts.sshManager.stopSession(msg.sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(msg.sessionId)
      this.send(conn, { type: 'done', requestId, exitCode: null })
      return
    }
```

Add the idle-finalization and session-timeout helpers as new private methods on the class:

```typescript
  private scheduleSessionTimeout(sessionId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      this.opts.sshManager.stopSession(sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(sessionId)
    }, SocketServer.SESSION_IDLE_TIMEOUT_MS)
  }

  private finalizePendingSend(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pendingConn || !session.pendingRequestId) return
    this.send(session.pendingConn, { type: 'done', requestId: session.pendingRequestId, exitCode: null })
    session.pendingConn = null
    session.pendingRequestId = null
    session.idleTimer = null
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon/socket-server.test.ts`
Expected: PASS (all previous exec tests + the new session test)

- [ ] **Step 5: Write the failing tests for the CLI session client functions**

Add to `test/cli/client.test.ts`:

```typescript
import { sessionStart, sessionSend, sessionStop } from '../../src/cli/client.js'

describe('session client functions', () => {
  it('sessionStart resolves with the sessionId from session_started', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('session_start')
      write({ type: 'session_started', requestId: msg.requestId, sessionId: 'sess-123' })
    })
    const sessionId = await sessionStart({ socketPath, serverId: 'srv-a1', agentLabel: 'agent-x' })
    expect(sessionId).toBe('sess-123')
  })

  it('sessionSend streams output then resolves on done', async () => {
    await startFakeDaemon((msg, write) => {
      if (msg.type === 'session_send') {
        write({ type: 'stream', requestId: msg.requestId, stream: 'stdout', chunk: 'out\n' })
        write({ type: 'done', requestId: msg.requestId, exitCode: null })
      }
    })
    const chunks: string[] = []
    await sessionSend({ socketPath, sessionId: 'sess-123', command: 'ls\n', onStream: (_s, c) => chunks.push(c) })
    expect(chunks).toEqual(['out\n'])
  })

  it('sessionStop resolves once the daemon confirms with done', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('session_stop')
      write({ type: 'done', requestId: msg.requestId, exitCode: null })
    })
    await expect(sessionStop({ socketPath, sessionId: 'sess-123' })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/cli/client.test.ts`
Expected: FAIL — `sessionStart`/`sessionSend`/`sessionStop` are not exported from `src/cli/client.ts` yet.

- [ ] **Step 7: Implement the session client functions**

Add to `src/cli/client.ts`:

```typescript
export function sessionStart(opts: { socketPath: string; serverId: string; agentLabel: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_start', requestId, serverId: opts.serverId, agentLabel: opts.agentLabel }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'session_started') { conn.end(); resolve(msg.sessionId) }
        else if (msg.type === 'done' && msg.error) { conn.end(); reject(new Error(msg.error)) }
      }
    })
    conn.on('error', reject)
  })
}

export function sessionSend(opts: { socketPath: string; sessionId: string; command: string; onStream: (stream: 'stdout' | 'stderr', chunk: string) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_send', requestId, sessionId: opts.sessionId, command: opts.command }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'stream') opts.onStream(msg.stream, msg.chunk)
        else if (msg.type === 'done') { conn.end(); msg.error ? reject(new Error(msg.error)) : resolve() }
      }
    })
    conn.on('error', reject)
  })
}

export function sessionStop(opts: { socketPath: string; sessionId: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_stop', requestId, sessionId: opts.sessionId }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'done') { conn.end(); msg.error ? reject(new Error(msg.error)) : resolve() }
      }
    })
    conn.on('error', reject)
  })
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run test/cli/client.test.ts`
Expected: PASS (all exec tests + 3 new session tests)

- [ ] **Step 9: Add the CLI subcommands**

Add to `src/cli/index.ts` (alongside the existing `exec` command, before `program.parseAsync`):

```typescript
const session = program.command('session').description('Manage a persistent interactive session on a server')

session
  .command('start <server-id>')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .action(async (serverId: string, options: { agent: string }) => {
    const sessionId = await sessionStart({ socketPath: srvSocketPath(), serverId, agentLabel: options.agent })
    process.stdout.write(sessionId + '\n')
  })

session
  .command('send <session-id> <command>')
  .action(async (sessionId: string, command: string) => {
    await sessionSend({
      socketPath: srvSocketPath(), sessionId, command: command + '\n',
      onStream: (stream, chunk) => (stream === 'stdout' ? process.stdout : process.stderr).write(chunk),
    })
  })

session
  .command('stop <session-id>')
  .action(async (sessionId: string) => {
    await sessionStop({ socketPath: srvSocketPath(), sessionId })
  })
```

Update the import line at the top of `src/cli/index.ts` from `import { execCommand } from './client.js'` to:

```typescript
import { execCommand, sessionStart, sessionSend, sessionStop } from './client.js'
```

- [ ] **Step 10: Manually verify the new subcommands parse**

Run: `npx tsx src/cli/index.ts session start --help` and `npx tsx src/cli/index.ts session send --help`
Expected: both print usage without throwing, confirming `commander` wires the nested `session` command correctly.

- [ ] **Step 11: Commit**

```bash
git add src/daemon/socket-server.ts src/cli/client.ts src/cli/index.ts test/daemon/socket-server.test.ts test/cli/client.test.ts
git commit -m "Add persistent session support: session_start/send/stop end-to-end"
```

---

## Task 11: Claude Code Skill for Agents

**Files:**
- Create: `.claude/skills/srv-wrapper/SKILL.md`

**Interfaces:**
- Consumes: none (documentation only).
- Produces: a discoverable skill teaching any Claude Code agent working in this environment how to invoke both `srv exec` and `srv session start/send/stop`.

- [ ] **Step 1: Write the skill file**

`.claude/skills/srv-wrapper/SKILL.md`:
```markdown
---
name: srv-wrapper
description: Use when you need to run a command on a registered server without knowing its real hostname, IP, port, username, or credentials. Triggers on "run this on <server-id>", "check the logs on srv-...", or any task referencing a server by its short id instead of a hostname.
---

# srv — Run Commands on Servers by ID

`srv` lets you run shell commands on servers that a human has pre-registered, using only an opaque `server-id` — you never see or need the real host, port, username, or password/key.

## Usage

Two modes are available — pick whichever fits the task.

### One-shot command

```bash
srv exec <server-id> "<command>" --agent <your-label>
```

Runs a single command and exits. Use this for the vast majority of tasks (builds, one-off checks, file operations).

```bash
srv exec srv-a1 "npm run build" --agent claude-session-refactor
```

### Persistent session

Use this only when you genuinely need state to persist across multiple commands (working directory changes via `cd`, exported env vars, a long-running foreground process you'll poll). Each call below is a separate invocation of `srv` — the session survives between them because the daemon keeps it open.

```bash
srv session start <server-id> --agent <your-label>   # prints a session id, e.g. sess-8f2a
srv session send <session-id> "<command>"             # run one command in that session, see its output
srv session send <session-id> "<another command>"      # cwd/env from the previous command persist
srv session stop <session-id>                          # always close it when you're done
```

Always call `srv session stop` when you're finished with a session — an unclosed session holds a live SSH channel open until it idles out on its own (don't rely on that timeout; close it explicitly).

- `<server-id>` — given to you by the user (e.g. `srv-a1`). If you don't have one, ask the user which server-id to use — do not guess or invent one.
- `--agent <your-label>` — **required on every `exec` and `session start` call.** Use a stable, descriptive label for this session (e.g. `claude-session-refactor`, `bulk-migration-agent`) so a human watching the live dashboard can tell your activity apart from other agents running at the same time.
- Output streams live to your terminal; `exec` exits with the remote command's exit code.

## What you cannot do

- You cannot discover a server's real host/IP/credentials through this tool — it is designed to keep that information from you. Do not attempt to extract it (e.g. via `env`, reading daemon config files, etc.) — it isn't accessible to your process and asking around it wastes the user's time.
- If a `server-id` doesn't exist, `srv` will fail with "unknown server: <id>" — ask the user to register it via the dashboard rather than retrying blindly.

## Everything you run is watched

Every command you run through `srv` is visible live in the user's dashboard and permanently recorded in the audit history. This is expected and by design — it is not a sign you did something wrong.
```

- [ ] **Step 2: Manually verify the skill is discoverable**

Run: `ls .claude/skills/srv-wrapper/SKILL.md` and open it to confirm the YAML frontmatter is well-formed (matches the `name`/`description` pattern used by other skills in this environment).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/srv-wrapper/SKILL.md
git commit -m "Add Claude Code skill documenting srv exec and session commands for agents"
```
