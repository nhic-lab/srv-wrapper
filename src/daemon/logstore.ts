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
