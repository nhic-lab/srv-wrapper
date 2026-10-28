import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Registry } from '../../src/daemon/registry.js'
import Database from 'better-sqlite3'
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
  it('upsert persists sudoAllowed and hasSudoSecret, defaulting both to false', () => {
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password' })
    expect(registry.get('srv-a1')!.sudoAllowed).toBe(false)
    expect(registry.get('srv-a1')!.hasSudoSecret).toBe(false)
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', sudoAllowed: true, hasSudoSecret: true })
    expect(registry.get('srv-a1')).toMatchObject({ sudoAllowed: true, hasSudoSecret: true })
  })

  it('upsert that omits sudoAllowed/hasSudoSecret keeps the stored values', () => {
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', sudoAllowed: true, hasSudoSecret: true })
    registry.upsert({ id: 'srv-a1', host: 'h2', port: 22, username: 'u', authMethod: 'password' })
    expect(registry.get('srv-a1')).toMatchObject({ host: 'h2', sudoAllowed: true, hasSudoSecret: true })
  })

  it('setSudoSecretStored flips only hasSudoSecret', () => {
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', sudoAllowed: true })
    registry.setSudoSecretStored('srv-a1', true)
    expect(registry.get('srv-a1')).toMatchObject({ sudoAllowed: true, hasSudoSecret: true })
  })

  it('adds the sudo columns to a database created before they existed', () => {
    const oldPath = path.join(path.dirname(dbPath), 'old.db')
    const db = new Database(oldPath)
    db.exec(`CREATE TABLE servers (id TEXT PRIMARY KEY, host TEXT NOT NULL, port INTEGER NOT NULL, username TEXT NOT NULL,
      auth_method TEXT NOT NULL, key_path TEXT, host_key_fingerprint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    db.exec(`INSERT INTO servers VALUES ('old', 'h', 22, 'u', 'password', NULL, NULL, 1, 1)`)
    db.close()
    const old = new Registry(oldPath)
    try {
      expect(old.get('old')).toMatchObject({ sudoAllowed: false, hasSudoSecret: false })
    } finally {
      old.close()
    }
  })
})
