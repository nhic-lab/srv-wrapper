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
