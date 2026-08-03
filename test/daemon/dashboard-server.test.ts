import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDashboardApp } from '../../src/daemon/dashboard-server.js'
import { Registry } from '../../src/daemon/registry.js'
import { Keychain } from '../../src/daemon/keychain.js'
import { LogStore } from '../../src/daemon/logstore.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import request from 'supertest'
import WebSocket from 'ws'

let dir: string
let registry: Registry
let logStore: LogStore
let keychain: Keychain
let secretsSet: Record<string, string>

/**
 * Builds a fake Keychain backed by `secrets`, fully implementing
 * add/delete/find so getSecret() round-trips real values. Pass
 * `failAddOnCall` (1-indexed) to make the Nth add-generic-password call
 * fail, simulating a real `security` CLI failure mid-request.
 */
function makeKeychain(secrets: Record<string, string>, failAddOnCall?: number): Keychain {
  let addCalls = 0
  return new Keychain('/usr/local/bin/srvd', (_cmd, args) => {
    if (args.includes('add-generic-password')) {
      addCalls += 1
      const id = args[args.indexOf('-a') + 1]
      const secret = args[args.indexOf('-w') + 1]
      if (failAddOnCall !== undefined && addCalls === failAddOnCall) {
        return { stdout: '', status: 1 }
      }
      secrets[id] = secret
      return { stdout: '', status: 0 }
    }
    if (args.includes('delete-generic-password')) {
      const id = args[args.indexOf('-a') + 1]
      delete secrets[id]
      return { stdout: '', status: 0 }
    }
    if (args.includes('find-generic-password')) {
      const id = args[args.indexOf('-a') + 1]
      if (Object.prototype.hasOwnProperty.call(secrets, id)) {
        return { stdout: secrets[id], status: 0 }
      }
      return { stdout: '', status: 1 }
    }
    return { stdout: '', status: 1 }
  })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-dash-test-'))
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  secretsSet = {}
  keychain = makeKeychain(secretsSet)
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

  it('POST /api/servers rejects registering a duplicate id (isEdit not set) instead of silently overwriting it', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    await request(app)
      .post('/api/servers')
      .send({ id: 'srv-dup', host: 'original-host', port: 22, username: 'orig-user', authMethod: 'password', secret: 'orig-secret' })

    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-dup', host: 'attacker-host', port: 2222, username: 'other-user', authMethod: 'password', secret: 'other-secret' })

    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already exists/)
    const record = registry.get('srv-dup')
    expect(record!.host).toBe('original-host')
    expect(secretsSet['srv-dup']).toBe('orig-secret')
  })

  it('POST /api/servers with isEdit but no matching record returns 404 instead of creating one', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-ghost', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's', isEdit: true })

    expect(res.status).toBe(404)
    expect(registry.get('srv-ghost')).toBeUndefined()
  })

  it('POST /api/servers with isEdit and a blank secret keeps the previously stored secret', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    await request(app)
      .post('/api/servers')
      .send({ id: 'srv-keepsecret', host: 'original-host', port: 22, username: 'orig-user', authMethod: 'password', secret: 'orig-secret' })

    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-keepsecret', host: 'updated-host', port: 22, username: 'orig-user', authMethod: 'password', secret: '', isEdit: true })

    expect(res.status).toBe(201)
    expect(registry.get('srv-keepsecret')!.host).toBe('updated-host')
    expect(secretsSet['srv-keepsecret']).toBe('orig-secret')
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

  it('POST /api/servers rolls back the registry entry if Keychain.setSecret throws', async () => {
    const failingKeychain = makeKeychain(secretsSet, 1)
    const { app } = createDashboardApp({ registry, keychain: failingKeychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-fail', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' })

    expect(res.status).toBe(500)
    expect(res.body.error).toBeDefined()
    expect(registry.get('srv-fail')).toBeUndefined()
  })

  it('POST /api/servers restores the ORIGINAL record and ORIGINAL secret when updating an existing server and Keychain.setSecret throws', async () => {
    const { app: goodApp } = createDashboardApp({ registry, keychain, logStore })
    await request(goodApp)
      .post('/api/servers')
      .send({ id: 'srv-edit', host: 'original-host', port: 22, username: 'orig-user', authMethod: 'password', secret: 'orig-secret' })

    const failingKeychain = makeKeychain(secretsSet, 1)
    const { app: failApp } = createDashboardApp({ registry, keychain: failingKeychain, logStore })
    const res = await request(failApp)
      .post('/api/servers')
      .send({ id: 'srv-edit', host: 'new-host', port: 2222, username: 'new-user', authMethod: 'password', secret: 'new-secret', isEdit: true })

    expect(res.status).toBe(500)
    const restored = registry.get('srv-edit')
    expect(restored).toBeDefined()
    expect(restored!.host).toBe('original-host')
    expect(restored!.port).toBe(22)
    expect(restored!.username).toBe('orig-user')
    expect(secretsSet['srv-edit']).toBe('orig-secret')
  })

  it('POST /api/servers returns a JSON 500 (not an unhandled exception) when Keychain.getSecret throws for an existing record, leaving the original record intact', async () => {
    const { app: goodApp } = createDashboardApp({ registry, keychain, logStore })
    await request(goodApp)
      .post('/api/servers')
      .send({ id: 'srv-getfail', host: 'original-host', port: 22, username: 'orig-user', authMethod: 'password', secret: 'orig-secret' })

    // Simulate the Keychain secret being missing/inaccessible independently of the registry
    // record (e.g. manually deleted from Keychain Access) -- getSecret throws for this id
    // even though a registry record already exists.
    const brokenKeychain = new Keychain('/usr/local/bin/srvd', (_cmd, args) => {
      if (args.includes('find-generic-password')) {
        return { stdout: '', status: 1 }
      }
      return { stdout: '', status: 0 }
    })
    const { app: failApp } = createDashboardApp({ registry, keychain: brokenKeychain, logStore })

    const res = await request(failApp)
      .post('/api/servers')
      .send({ id: 'srv-getfail', host: 'new-host', port: 2222, username: 'new-user', authMethod: 'password', secret: 'new-secret', isEdit: true })

    expect(res.status).toBe(500)
    expect(res.body.error).toBeDefined()
    const record = registry.get('srv-getfail')
    expect(record).toBeDefined()
    expect(record!.host).toBe('original-host')
    expect(record!.port).toBe(22)
    expect(record!.username).toBe('orig-user')
  })

  it('POST /api/servers/bulk restores the ORIGINAL record and ORIGINAL secret of a pre-existing server when a later entry in the batch fails', async () => {
    const { app: goodApp } = createDashboardApp({ registry, keychain, logStore })
    await request(goodApp)
      .post('/api/servers')
      .send({ id: 'srv-existing', host: 'original-host', port: 22, username: 'orig-user', authMethod: 'password', secret: 'orig-secret' })

    const failingKeychain = makeKeychain(secretsSet, 2)
    const { app: failApp } = createDashboardApp({ registry, keychain: failingKeychain, logStore })
    const res = await request(failApp)
      .post('/api/servers/bulk')
      .send({
        servers: [
          { id: 'srv-existing', host: 'updated-host', port: 2222, username: 'updated-user', authMethod: 'password', secret: 'new-secret' },
          { id: 'srv-new-fail', host: 'h2', port: 22, username: 'u2', authMethod: 'password', secret: 's2' },
        ],
      })

    expect(res.status).toBe(500)
    const restored = registry.get('srv-existing')
    expect(restored).toBeDefined()
    expect(restored!.host).toBe('original-host')
    expect(restored!.port).toBe(22)
    expect(restored!.username).toBe('orig-user')
    expect(secretsSet['srv-existing']).toBe('orig-secret')
    expect(registry.get('srv-new-fail')).toBeUndefined()
  })

  it('POST /api/servers/bulk rolls back all committed entries if Keychain.setSecret throws partway through', async () => {
    const failingKeychain = makeKeychain(secretsSet, 2)
    const { app } = createDashboardApp({ registry, keychain: failingKeychain, logStore })
    const res = await request(app)
      .post('/api/servers/bulk')
      .send({
        servers: [
          { id: 'srv-y1', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' },
          { id: 'srv-y2', host: 'h2', port: 22, username: 'u2', authMethod: 'password', secret: 's2' },
        ],
      })

    expect(res.status).toBe(500)
    const list = await request(app).get('/api/servers')
    expect(list.body).toHaveLength(0)
    expect(secretsSet['srv-y1']).toBeUndefined()
    expect(secretsSet['srv-y2']).toBeUndefined()
  })

  it('POST /api/servers/bulk rejects a malformed (non-array) servers payload with 400', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app).post('/api/servers/bulk').send({ servers: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  it('POST /api/servers rejects an id containing invalid characters', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv a/1', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' })
    expect(res.status).toBe(400)
  })

  it('POST /api/servers rejects a non-integer or out-of-range port', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res1 = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-p1', host: 'h', port: 1.5, username: 'u', authMethod: 'password', secret: 's' })
    expect(res1.status).toBe(400)

    const res2 = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-p2', host: 'h', port: 70000, username: 'u', authMethod: 'password', secret: 's' })
    expect(res2.status).toBe(400)
  })

  it('POST /api/servers rejects authMethod "key" without a keyPath', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-k1', host: 'h', port: 22, username: 'u', authMethod: 'key', secret: 's' })
    expect(res.status).toBe(400)
  })

  it('POST /api/servers rejects authMethod "password" with a keyPath set', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-k2', host: 'h', port: 22, username: 'u', authMethod: 'password', keyPath: '/tmp/id_rsa', secret: 's' })
    expect(res.status).toBe(400)
  })

  it('rejects a WebSocket connection to /api/live from a disallowed Origin', async () => {
    const { app } = createDashboardApp({ registry, keychain, logStore })
    const server = http.createServer(app)
    ;(app as any).attachWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const rejection = await new Promise<{ rejected: boolean }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, {
        headers: { Origin: 'http://evil.example.com' },
      })
      ws.on('open', () => resolve({ rejected: false }))
      ws.on('unexpected-response', () => resolve({ rejected: true }))
      ws.on('error', () => resolve({ rejected: true }))
    })

    expect(rejection.rejected).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
