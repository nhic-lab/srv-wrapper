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
        host_key_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const cols = this.db.prepare(`PRAGMA table_info(servers)`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'host_key_fingerprint')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN host_key_fingerprint TEXT`)
    }
    if (!cols.some((c) => c.name === 'jump_chain')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN jump_chain TEXT`)
    }
    // Reachability is persisted so the Servers view's online/offline filter is
    // still meaningful after a refresh or a daemon restart — with 50+ servers,
    // re-running "Test all" just to repopulate an in-memory map is not viable.
    if (!cols.some((c) => c.name === 'last_test_at')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN last_test_at INTEGER`)
    }
    if (!cols.some((c) => c.name === 'last_test_ok')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN last_test_ok INTEGER`)
    }
    if (!cols.some((c) => c.name === 'last_test_error')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN last_test_error TEXT`)
    }
    if (!cols.some((c) => c.name === 'sudo_allowed')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN sudo_allowed INTEGER NOT NULL DEFAULT 0`)
    }
    if (!cols.some((c) => c.name === 'sudo_secret_stored')) {
      this.db.exec(`ALTER TABLE servers ADD COLUMN sudo_secret_stored INTEGER NOT NULL DEFAULT 0`)
    }
  }

  upsert(record: Omit<ServerRecord, 'createdAt' | 'updatedAt'>): ServerRecord {
    const now = Date.now()
    const existing = this.get(record.id)
    const createdAt = existing?.createdAt ?? now

    this.db
      .prepare(
        `INSERT INTO servers (id, host, port, username, auth_method, key_path, jump_chain, sudo_allowed, sudo_secret_stored, created_at, updated_at)
         VALUES (@id, @host, @port, @username, @authMethod, @keyPath, @jumpChain, @sudoAllowed, @sudoSecretStored, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           host=excluded.host, port=excluded.port, username=excluded.username,
           auth_method=excluded.auth_method, key_path=excluded.key_path, jump_chain=excluded.jump_chain,
           sudo_allowed=excluded.sudo_allowed, sudo_secret_stored=excluded.sudo_secret_stored, updated_at=excluded.updated_at`
      )
      .run({
        id: record.id,
        host: record.host,
        port: record.port,
        username: record.username,
        authMethod: record.authMethod,
        keyPath: record.keyPath ?? null,
        jumpChain: record.jumpChain && record.jumpChain.length > 0 ? JSON.stringify(record.jumpChain) : null,
        // Omitted on an edit means "keep what is stored", like the reachability columns.
        sudoAllowed: (record.sudoAllowed ?? existing?.sudoAllowed ?? false) ? 1 : 0,
        sudoSecretStored: (record.hasSudoSecret ?? existing?.hasSudoSecret ?? false) ? 1 : 0,
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
      hostKeyFingerprint: row.host_key_fingerprint ?? undefined,
      jumpChain: row.jump_chain ? JSON.parse(row.jump_chain) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastTestAt: row.last_test_at ?? undefined,
      lastTestOk: row.last_test_ok == null ? undefined : Boolean(row.last_test_ok),
      lastTestError: row.last_test_error ?? undefined,
      sudoAllowed: Boolean(row.sudo_allowed),
      hasSudoSecret: Boolean(row.sudo_secret_stored),
    }
  }

  setSudoSecretStored(id: string, stored: boolean): void {
    this.db.prepare('UPDATE servers SET sudo_secret_stored = ? WHERE id = ?').run(stored ? 1 : 0, id)
  }

  setHostKeyFingerprint(id: string, fingerprint: string): void {
    this.db.prepare('UPDATE servers SET host_key_fingerprint = ? WHERE id = ?').run(fingerprint, id)
  }

  /** Records the outcome of a reachability check. `error` is the already
   *  sanitized message — never a raw ssh2/Node error (see sanitizeSshError). */
  setTestResult(id: string, ok: boolean, error?: string): void {
    this.db
      .prepare('UPDATE servers SET last_test_at = ?, last_test_ok = ?, last_test_error = ? WHERE id = ?')
      .run(Date.now(), ok ? 1 : 0, ok ? null : (error ?? null), id)
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
