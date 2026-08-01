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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-dash-test-'))
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  secretsSet = {}
  keychain = new Keychain('/usr/local/bin/srvd', (cmd, args) => {
    if (args.includes('add-generic-password')) {
      secretsSet[args[args.indexOf('-a') + 1]] = args[args.indexOf('-w') + 1]
      return { stdout: '', status: 0 }
    }
    if (args.includes('delete-generic-password')) {
      delete secretsSet[args[args.indexOf('-a') + 1]]
      return { stdout: '', status: 0 }
    }
    return { stdout: '', status: 1 }
  })
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
    const failingKeychain = new Keychain('/usr/local/bin/srvd', (cmd, args) => {
      if (args.includes('add-generic-password')) return { stdout: '', status: 1 }
      return { stdout: '', status: 0 }
    })
    const { app } = createDashboardApp({ registry, keychain: failingKeychain, logStore })
    const res = await request(app)
      .post('/api/servers')
      .send({ id: 'srv-fail', host: 'h', port: 22, username: 'u', authMethod: 'password', secret: 's' })

    expect(res.status).toBe(500)
    expect(res.body.error).toBeDefined()
    expect(registry.get('srv-fail')).toBeUndefined()
  })

  it('POST /api/servers/bulk rolls back all committed entries if Keychain.setSecret throws partway through', async () => {
    let calls = 0
    const failingKeychain = new Keychain('/usr/local/bin/srvd', (cmd, args) => {
      if (args.includes('add-generic-password')) {
        calls += 1
        if (calls === 2) return { stdout: '', status: 1 }
        const id = args[args.indexOf('-a') + 1]
        secretsSet[id] = args[args.indexOf('-w') + 1]
        return { stdout: '', status: 0 }
      }
      if (args.includes('delete-generic-password')) {
        const id = args[args.indexOf('-a') + 1]
        delete secretsSet[id]
        return { stdout: '', status: 0 }
      }
      return { stdout: '', status: 1 }
    })
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
