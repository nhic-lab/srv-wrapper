import express from 'express'
import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import type { Registry } from './registry.js'
import type { Keychain } from './keychain.js'
import type { LogStore } from './logstore.js'

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
  if (!input.id) return 'missing id'
  if (!input.host) return 'missing host'
  if (!input.port) return 'missing port'
  if (!input.username) return 'missing username'
  if (input.authMethod !== 'password' && input.authMethod !== 'key') return 'authMethod must be password or key'
  if (!input.secret) return 'missing secret'
  return null
}

export function createDashboardApp(opts: DashboardOptions): { app: express.Express; broadcast: (event: object) => void } {
  const app = express()
  app.use(express.json())

  const wsClients = new Set<import('ws').WebSocket>()
  const broadcast = (event: object) => {
    const payload = JSON.stringify(event)
    for (const client of wsClients) client.send(payload)
  }

  app.post('/api/servers', (req, res) => {
    const input: ServerInput = req.body
    const error = validateServerInput(input)
    if (error) return res.status(400).json({ error })

    const record = opts.registry.upsert({
      id: input.id, host: input.host, port: input.port, username: input.username,
      authMethod: input.authMethod, keyPath: input.keyPath,
    })
    opts.keychain.setSecret(input.id, input.secret)
    res.status(201).json(record)
  })

  app.post('/api/servers/bulk', (req, res) => {
    const servers: ServerInput[] = req.body.servers ?? []
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
    for (const input of valid) {
      opts.registry.upsert({
        id: input.id, host: input.host, port: input.port, username: input.username,
        authMethod: input.authMethod, keyPath: input.keyPath,
      })
      opts.keychain.setSecret(input.id, input.secret)
      succeeded.push(input.id)
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

  const attachWebSocket = (server: Server) => {
    const wss = new WebSocketServer({ server, path: '/api/live' })
    wss.on('connection', (ws) => {
      wsClients.add(ws)
      ws.on('close', () => wsClients.delete(ws))
    })
  }

  ;(app as any).attachWebSocket = attachWebSocket

  return { app, broadcast }
}
