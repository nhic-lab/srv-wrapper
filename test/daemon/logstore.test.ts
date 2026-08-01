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
