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

  it('list omits output so a huge run cannot bloat the response', () => {
    store.start({ id: 'run-1', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'x' })
    store.appendOutput('run-1', 'hello world\n')
    const [row] = store.list()
    expect((row as any).output).toBeUndefined()
    expect(row.outputBytes).toBe(12)
    expect(row.hasOutput).toBe(true)
  })

  it('list returns newest first and honours limit/offset', () => {
    for (let i = 0; i < 5; i++) {
      store.start({ id: `run-${i}`, serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'x' })
      // started_at comes from Date.now(); nudge ordering deterministically
      store['db'].prepare('UPDATE runs SET started_at = ? WHERE id = ?').run(1000 + i, `run-${i}`)
    }
    expect(store.list().map((r) => r.id)).toEqual(['run-4', 'run-3', 'run-2', 'run-1', 'run-0'])
    expect(store.list({ limit: 2 }).map((r) => r.id)).toEqual(['run-4', 'run-3'])
    expect(store.list({ limit: 2, offset: 2 }).map((r) => r.id)).toEqual(['run-2', 'run-1'])
  })

  it('count reports the total independently of limit', () => {
    for (let i = 0; i < 4; i++) {
      store.start({ id: `run-${i}`, serverId: i < 3 ? 'srv-a1' : 'srv-b7', agentLabel: 'a', kind: 'exec', command: 'x' })
    }
    expect(store.count()).toBe(4)
    expect(store.count({ serverId: 'srv-a1' })).toBe(3)
    expect(store.list({ limit: 1 })).toHaveLength(1)
  })

  it('caps stored output, keeping head and tail with an elision marker', () => {
    store.start({ id: 'big', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'dump' })
    const head = 'HEAD_MARKER\n'
    const tail = '\nTAIL_MARKER'
    store.appendOutput('big', head)
    // 400 chunks of 4 KB = ~1.6 MB, comfortably past the 256 KB cap
    for (let i = 0; i < 400; i++) store.appendOutput('big', 'x'.repeat(4096))
    store.appendOutput('big', tail)
    store.finish('big', 0)

    const rec = store.get('big')!
    expect(rec.truncated).toBe(true)
    expect(rec.output.startsWith(head)).toBe(true)
    expect(rec.output.endsWith(tail)).toBe(true)
    expect(rec.output).toContain('elided by srv-wrapper')
    // stored output stays bounded even though the run produced ~1.6 MB
    expect(rec.output.length).toBeLessThan(300 * 1024)
    expect(rec.outputBytes).toBeGreaterThan(1_600_000)
  })

  it('backfills output_bytes for rows written before the column existed', () => {
    // Simulate the compact-log script having created the columns first: the
    // column exists, rows have output, but output_bytes was never populated.
    store.start({ id: 'old-1', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'x' })
    store.appendOutput('old-1', 'twelve chars')
    const db = store['db']
    db.prepare('UPDATE runs SET output_bytes = 0 WHERE id = ?').run('old-1')
    db.pragma('user_version = 0')
    store.close()

    const reopened = new LogStore(dbPath)
    try {
      expect(reopened.list().find((r) => r.id === 'old-1')?.outputBytes).toBe(12)
      // and it must not run twice / clobber live values
      expect(reopened['db'].pragma('user_version', { simple: true })).toBe(1)
    } finally {
      reopened.close()
      store = new LogStore(dbPath) // so afterEach can close something valid
    }
  })

  it('does not truncate output that stays under the cap', () => {
    store.start({ id: 'small', serverId: 'srv-a1', agentLabel: 'a', kind: 'exec', command: 'ls' })
    const body = 'y'.repeat(60 * 1024)
    store.appendOutput('small', body)
    store.finish('small', 0)
    const rec = store.get('small')!
    expect(rec.truncated).toBe(false)
    expect(rec.output).toBe(body)
    expect(rec.output).not.toContain('elided')
  })
})
