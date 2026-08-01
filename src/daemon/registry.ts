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
