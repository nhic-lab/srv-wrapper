import Database from 'better-sqlite3'
import type { RunRecord, RunSummary } from '../shared/types.js'

/**
 * Stored output is capped per run: the first HEAD_CHARS and last TAIL_CHARS are
 * kept with an elision marker between them. A handful of `mysql`/`docker exec`
 * dumps had grown to ~97 MB each and accounted for 96% of a 1.8 GB log.db,
 * which made `GET /api/history` fail outright with "RangeError: Invalid string
 * length" once the combined output passed V8's ~512 MB string ceiling.
 *
 * The cap also removes a quadratic write cost: `output = output || chunk`
 * rewrites the entire column on every chunk, so a 97 MB run rewrote ~97 MB
 * thousands of times. With the cap the column never exceeds ~256 KB.
 */
const HEAD_CHARS = 128 * 1024
const TAIL_CHARS = 128 * 1024
const DEFAULT_LIST_LIMIT = 500

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function elisionMarker(bytes: number): string {
  return `\n\n… ${fmtBytes(bytes)} of output elided by srv-wrapper (head and tail kept) …\n\n`
}

export class LogStore {
  private db: Database.Database

  /** Runs whose stored output has hit the cap: we hold head/tail in memory and
   *  stop touching the `output` column until the run finishes. */
  private capped = new Map<string, { head: string; tail: string; elided: number }>()

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
    const cols = this.db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'output_bytes')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN output_bytes INTEGER NOT NULL DEFAULT 0`)
    }
    if (!cols.some((c) => c.name === 'truncated')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0`)
    }

    // Backfill sizes for rows written before output_bytes existed. This is
    // keyed off user_version rather than "did we just add the column", because
    // scripts/compact-log.mjs may have created the column first — in which case
    // a creation-time backfill never runs and every older row reports 0 bytes.
    // user_version guarantees this happens exactly once per database.
    const schemaVersion = this.db.pragma('user_version', { simple: true }) as number
    if (schemaVersion < 1) {
      this.db.exec(`UPDATE runs SET output_bytes = length(output) WHERE output_bytes = 0 AND length(output) > 0`)
      this.db.pragma('user_version = 1')
    }
    // History is always read newest-first, and always filtered by server id on
    // the server-detail pane; without this every read was a full table scan.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC)`)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_server_started ON runs (server_id, started_at DESC)`)
  }

  start(input: { id: string; serverId: string; agentLabel: string; kind: 'exec' | 'session'; command: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, server_id, agent_label, kind, command, output, output_bytes, truncated, exit_code, started_at, ended_at)
         VALUES (@id, @serverId, @agentLabel, @kind, @command, '', 0, 0, NULL, @startedAt, NULL)`
      )
      .run({ ...input, startedAt: Date.now() })
  }

  appendOutput(id: string, chunk: string): void {
    const bytes = Buffer.byteLength(chunk)
    const cap = this.capped.get(id)

    if (cap) {
      // Already capped: keep a rolling tail in memory, touch only the counter.
      cap.tail += chunk
      if (cap.tail.length > TAIL_CHARS) {
        const over = cap.tail.length - TAIL_CHARS
        cap.elided += Buffer.byteLength(cap.tail.slice(0, over))
        cap.tail = cap.tail.slice(over)
      }
      this.db.prepare('UPDATE runs SET output_bytes = output_bytes + @bytes WHERE id = @id').run({ id, bytes })
      return
    }

    this.db
      .prepare('UPDATE runs SET output = output || @chunk, output_bytes = output_bytes + @bytes WHERE id = @id')
      .run({ id, chunk, bytes })

    const row = this.db.prepare('SELECT length(output) AS len FROM runs WHERE id = ?').get(id) as { len: number } | undefined
    if (!row || row.len <= HEAD_CHARS + TAIL_CHARS) return

    const full = (this.db.prepare('SELECT output FROM runs WHERE id = ?').get(id) as { output: string }).output
    const entry = {
      head: full.slice(0, HEAD_CHARS),
      tail: full.slice(full.length - TAIL_CHARS),
      elided: Buffer.byteLength(full.slice(HEAD_CHARS, full.length - TAIL_CHARS)),
    }
    this.capped.set(id, entry)
    this.db.prepare('UPDATE runs SET truncated = 1 WHERE id = ?').run(id)
    this.flushCapped(id)
  }

  private flushCapped(id: string): void {
    const cap = this.capped.get(id)
    if (!cap) return
    this.db
      .prepare('UPDATE runs SET output = @output WHERE id = @id')
      .run({ id, output: cap.head + elisionMarker(cap.elided) + cap.tail })
  }

  finish(id: string, exitCode: number | null): void {
    if (this.capped.has(id)) {
      this.flushCapped(id)
      this.capped.delete(id)
    }
    this.db
      .prepare('UPDATE runs SET exit_code = @exitCode, ended_at = @endedAt WHERE id = @id')
      .run({ id, exitCode, endedAt: Date.now() })
  }

  get(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as any
    if (!row) return undefined
    return this.rowToRecord(row)
  }

  /**
   * Run metadata only, newest first — deliberately without `output`. The
   * dashboard's list pane never needs output, and sending it for every run is
   * what broke this endpoint. Fetch a single run (with output) via `get`.
   */
  list(filter?: { serverId?: string; agentLabel?: string; limit?: number; offset?: number }): RunSummary[] {
    let query = `SELECT id, server_id, agent_label, kind, command, exit_code, started_at, ended_at,
                        output_bytes, truncated, length(output) AS stored_chars
                 FROM runs`
    const clauses: string[] = []
    const params: Record<string, string | number> = {}
    if (filter?.serverId) {
      clauses.push('server_id = @serverId')
      params.serverId = filter.serverId
    }
    if (filter?.agentLabel) {
      clauses.push('agent_label = @agentLabel')
      params.agentLabel = filter.agentLabel
    }
    if (clauses.length) query += ' WHERE ' + clauses.join(' AND ')
    query += ' ORDER BY started_at DESC LIMIT @limit OFFSET @offset'
    params.limit = Math.max(1, Math.min(filter?.limit ?? DEFAULT_LIST_LIMIT, 5000))
    params.offset = Math.max(0, filter?.offset ?? 0)

    const rows = this.db.prepare(query).all(params) as any[]
    return rows.map((r) => ({
      id: r.id,
      serverId: r.server_id,
      agentLabel: r.agent_label,
      kind: r.kind,
      command: r.command,
      exitCode: r.exit_code,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outputBytes: r.output_bytes,
      truncated: Boolean(r.truncated),
      hasOutput: r.stored_chars > 0,
    }))
  }

  /** Total number of runs, for "showing N of M" in the UI. */
  count(filter?: { serverId?: string; agentLabel?: string }): number {
    let query = 'SELECT count(*) AS n FROM runs'
    const clauses: string[] = []
    const params: Record<string, string> = {}
    if (filter?.serverId) { clauses.push('server_id = @serverId'); params.serverId = filter.serverId }
    if (filter?.agentLabel) { clauses.push('agent_label = @agentLabel'); params.agentLabel = filter.agentLabel }
    if (clauses.length) query += ' WHERE ' + clauses.join(' AND ')
    return (this.db.prepare(query).get(params) as { n: number }).n
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
      outputBytes: row.output_bytes ?? row.output?.length ?? 0,
      truncated: Boolean(row.truncated),
    }
  }

  close(): void {
    this.db.close()
  }
}
