import express from 'express'
import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import type { Registry } from './registry.js'
import type { Keychain } from './keychain.js'
import type { LogStore } from './logstore.js'
import type { ServerRecord } from '../shared/types.js'

interface DashboardOptions {
  registry: Registry
  keychain: Keychain
  logStore: LogStore
}

interface ServerInput {
  id: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  keyPath?: string
  secret: string
}

function validateServerInput(input: any): string | null {
  if (!input.id || typeof input.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.id)) return 'invalid or missing id'
  if (!input.host || typeof input.host !== 'string') return 'missing host'
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'port must be an integer between 1 and 65535'
  if (!input.username || typeof input.username !== 'string') return 'missing username'
  if (input.authMethod !== 'password' && input.authMethod !== 'key') return 'authMethod must be password or key'
  if (input.authMethod === 'key' && !input.keyPath) return 'keyPath is required when authMethod is key'
  if (input.authMethod === 'password' && input.keyPath) return 'keyPath must not be set when authMethod is password'
  if (!input.secret) return 'missing secret'
  return null
}

export function createDashboardApp(opts: DashboardOptions): { app: express.Express; broadcast: (event: object) => void } {
  const app = express()
  app.use(express.json({ limit: '32kb' }))

  const wsClients = new Set<import('ws').WebSocket>()
  const broadcast = (event: object) => {
    const payload = JSON.stringify(event)
    for (const client of wsClients) client.send(payload)
  }

  app.post('/api/servers', (req, res) => {
    const input: ServerInput = req.body
    const error = validateServerInput(input)
    if (error) return res.status(400).json({ error })

    const existing = opts.registry.get(input.id)
    const record = opts.registry.upsert({
      id: input.id, host: input.host, port: input.port, username: input.username,
      authMethod: input.authMethod, keyPath: input.keyPath,
    })
    try {
      opts.keychain.setSecret(input.id, input.secret)
    } catch (err: any) {
      if (existing) {
        opts.registry.upsert({
          id: existing.id, host: existing.host, port: existing.port, username: existing.username,
          authMethod: existing.authMethod, keyPath: existing.keyPath,
        })
      } else {
        opts.registry.delete(input.id)
      }
      return res.status(500).json({ error: `failed to store secret: ${err?.message ?? err}` })
    }
    res.status(201).json(record)
  })

  app.post('/api/servers/bulk', (req, res) => {
    if (!Array.isArray(req.body.servers)) {
      return res.status(400).json({ error: 'servers must be an array' })
    }
    const servers: ServerInput[] = req.body.servers
    const seenIds = new Set<string>()
    const failed: Array<{ id?: string; error: string }> = []
    const valid: ServerInput[] = []

    for (const input of servers) {
      const error = validateServerInput(input)
      if (error) { failed.push({ id: input.id, error }); continue }
      if (seenIds.has(input.id)) { failed.push({ id: input.id, error: 'duplicate id in batch' }); continue }
      seenIds.add(input.id)
      valid.push(input)
    }

    if (failed.length > 0) {
      return res.json({ succeeded: [], failed })
    }

    const succeeded: string[] = []
    const committed: Array<{ id: string; priorRecord: ServerRecord | undefined }> = []
    try {
      for (const input of valid) {
        const priorRecord = opts.registry.get(input.id)
        opts.registry.upsert({
          id: input.id, host: input.host, port: input.port, username: input.username,
          authMethod: input.authMethod, keyPath: input.keyPath,
        })
        committed.push({ id: input.id, priorRecord })
        opts.keychain.setSecret(input.id, input.secret)
        succeeded.push(input.id)
      }
    } catch (err: any) {
      for (const { id, priorRecord } of committed) {
        if (priorRecord) {
          opts.registry.upsert({
            id: priorRecord.id, host: priorRecord.host, port: priorRecord.port, username: priorRecord.username,
            authMethod: priorRecord.authMethod, keyPath: priorRecord.keyPath,
          })
        } else {
          opts.registry.delete(id)
          opts.keychain.deleteSecret(id)
        }
      }
      return res.status(500).json({ error: `bulk import failed partway, rolled back: ${err?.message ?? err}`, succeeded: [], failed: [] })
    }
    res.json({ succeeded, failed: [] })
  })

  app.get('/api/servers', (_req, res) => {
    res.json(opts.registry.list())
  })

  app.delete('/api/servers/:id', (req, res) => {
    opts.registry.delete(req.params.id)
    opts.keychain.deleteSecret(req.params.id)
    res.status(204).end()
  })

  app.get('/api/history', (req, res) => {
    const { serverId, agentLabel } = req.query as { serverId?: string; agentLabel?: string }
    res.json(opts.logStore.list({ serverId, agentLabel }))
  })

  app.use(express.static(new URL('../../public', import.meta.url).pathname))

  const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:4280', 'http://localhost:4280'])

  const attachWebSocket = (server: Server) => {
    const wss = new WebSocketServer({
      server,
      path: '/api/live',
      verifyClient: (info, cb) => {
        if (!info.origin || !ALLOWED_ORIGINS.has(info.origin)) {
          cb(false, 403, 'forbidden origin')
          return
        }
        cb(true)
      },
    })
    wss.on('connection', (ws) => {
      wsClients.add(ws)
      ws.on('close', () => wsClients.delete(ws))
    })
  }

  ;(app as any).attachWebSocket = attachWebSocket

  return { app, broadcast }
}
