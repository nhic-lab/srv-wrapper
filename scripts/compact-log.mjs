#!/usr/bin/env node
/**
 * One-time compaction of ~/.srv/log.db.
 *
 * New runs are capped at write time by LogStore, but runs recorded before that
 * cap existed can be enormous (a handful of `mysqldump`/`docker exec` runs held
 * 96% of a 1.8 GB database, and made GET /api/history fail outright with
 * "RangeError: Invalid string length").
 *
 * For every oversized row this keeps the first and last 128 KB of output with
 * an elision marker between them, records the original size in output_bytes so
 * the UI still reports the true volume, then VACUUMs to reclaim the space.
 * Run metadata — id, server, agent, command, exit code, timings — is untouched,
 * so nothing disappears from the audit history.
 *
 * DESTRUCTIVE: the elided middle of those outputs cannot be recovered.
 * The daemon must be stopped first, or SQLite will be writing underneath us.
 *
 *   launchctl bootout gui/$(id -u)/com.srv-wrapper.daemon
 *   node scripts/compact-log.mjs --yes
 *   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.srv-wrapper.daemon.plist
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAD = 128 * 1024
const TAIL = 128 * 1024
const CAP = HEAD + TAIL

const dbPath = process.env.SRV_LOG_DB || path.join(os.homedir(), '.srv', 'log.db')
const confirmed = process.argv.includes('--yes')
const dryRun = process.argv.includes('--dry-run')

function fmt(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

if (!fs.existsSync(dbPath)) {
  console.error(`no log database at ${dbPath}`)
  process.exit(1)
}

// Refuse to run while the daemon still holds the socket — a concurrent writer
// would make the row rewrites race and leave the WAL enormous.
const sockPath = path.join(path.dirname(dbPath), 'srv.sock')
if (!dryRun && fs.existsSync(sockPath)) {
  try {
    const net = await import('node:net')
    await new Promise((resolve, reject) => {
      const probe = net.createConnection(sockPath)
      probe.on('connect', () => { probe.destroy(); reject(new Error('daemon is running')) })
      probe.on('error', () => resolve())
      setTimeout(() => { probe.destroy(); resolve() }, 400)
    })
  } catch {
    console.error('The srv daemon appears to be running. Stop it first:')
    console.error('  launchctl bootout gui/$(id -u)/com.srv-wrapper.daemon')
    process.exit(1)
  }
}

const before = fs.statSync(dbPath).size
const wal = `${dbPath}-wal`
const beforeWal = fs.existsSync(wal) ? fs.statSync(wal).size : 0

const db = new Database(dbPath)

// The columns may not exist yet if the new daemon has never opened this file.
const cols = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name)
if (!cols.includes('output_bytes')) db.exec('ALTER TABLE runs ADD COLUMN output_bytes INTEGER NOT NULL DEFAULT 0')
if (!cols.includes('truncated')) db.exec('ALTER TABLE runs ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0')

const stats = db.prepare(`
  SELECT count(*) AS n, coalesce(sum(length(output)), 0) AS bytes
  FROM runs WHERE length(output) > @cap
`).get({ cap: CAP })

const totals = db.prepare('SELECT count(*) AS n, coalesce(sum(length(output)),0) AS bytes FROM runs').get()

console.log(`database        ${dbPath}`)
console.log(`file size       ${fmt(before)}${beforeWal ? ` (+ ${fmt(beforeWal)} WAL)` : ''}`)
console.log(`runs            ${totals.n} holding ${fmt(totals.bytes)} of output`)
console.log(`oversized runs  ${stats.n} holding ${fmt(stats.bytes)} (cap is ${fmt(CAP)} per run)`)

if (stats.n === 0) {
  console.log('\nnothing to compact.')
  db.close()
  process.exit(0)
}

const projected = totals.bytes - stats.bytes + stats.n * CAP
console.log(`projected       ${fmt(totals.bytes)} -> ~${fmt(projected)} of output`)

if (dryRun) {
  console.log('\n--dry-run: no changes made.')
  db.close()
  process.exit(0)
}
if (!confirmed) {
  console.log('\nThis rewrites those outputs irreversibly. Re-run with --yes to proceed.')
  db.close()
  process.exit(1)
}

// Preserve the true original size before shortening the text.
db.exec(`UPDATE runs SET output_bytes = max(output_bytes, length(output)) WHERE length(output) > ${CAP}`)

const rows = db.prepare(`SELECT id, length(output) AS len FROM runs WHERE length(output) > @cap`).all({ cap: CAP })
const update = db.prepare('UPDATE runs SET output = @output, truncated = 1 WHERE id = @id')
const readOne = db.prepare('SELECT output FROM runs WHERE id = ?')

let done = 0
const compact = db.transaction(() => {
  for (const row of rows) {
    const full = readOne.get(row.id).output
    const head = full.slice(0, HEAD)
    const tail = full.slice(full.length - TAIL)
    const elided = Buffer.byteLength(full.slice(HEAD, full.length - TAIL))
    const marker = `\n\n… ${fmt(elided)} of output elided by srv-wrapper (head and tail kept) …\n\n`
    update.run({ id: row.id, output: head + marker + tail })
    done += 1
    if (done % 25 === 0) console.log(`  compacted ${done}/${rows.length}`)
  }
})
compact()
console.log(`  compacted ${done}/${rows.length}`)

console.log('vacuuming…')
db.pragma('wal_checkpoint(TRUNCATE)')
db.exec('VACUUM')
db.close()

const after = fs.statSync(dbPath).size
console.log(`\ndone: ${fmt(before)} -> ${fmt(after)} (freed ${fmt(Math.max(0, before - after))})`)
console.log(`${done} runs compacted; all ${totals.n} runs still present in history.`)
