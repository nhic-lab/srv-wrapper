import express from 'express'
import { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import type { Registry } from './registry.js'
import type { Keychain } from './keychain.js'
import type { LogStore } from './logstore.js'
import type { SshManager } from './ssh-manager.js'
import type { ServerRecord } from '../shared/types.js'
import { resolveJumpPath } from './jump-chain.js'
import { sanitizeSshError } from './socket-server.js'

interface DashboardOptions {
  registry: Registry
  keychain: Keychain
  logStore: LogStore
  sshManager?: SshManager
}

interface ServerInput {
  id: string
  host: string
  port: number
  username: string
  authMethod: 'password' | 'key'
  keyPath?: string
  jumpChain?: string[]
  secret: string
  isEdit?: boolean
}

function validateServerInput(input: any): string | null {
  if (!input.id || typeof input.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(input.id)) return 'invalid or missing id'
  if (!input.host || typeof input.host !== 'string') return 'missing host'
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'port must be an integer between 1 and 65535'
  if (!input.username || typeof input.username !== 'string') return 'missing username'
  if (input.authMethod !== 'password' && input.authMethod !== 'key') return 'authMethod must be password or key'
  if (input.authMethod === 'key' && !input.keyPath) return 'keyPath is required when authMethod is key'
  if (input.authMethod === 'password' && input.keyPath) return 'keyPath must not be set when authMethod is password'
  if (input.jumpChain !== undefined) {
    if (!Array.isArray(input.jumpChain) || !input.jumpChain.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
      return 'jumpChain must be an array of server ids'
    }
  }
  // Editing an existing server may omit the secret to keep the one already stored in Keychain.
  if (!input.secret && !input.isEdit) return 'missing secret'
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
    if (existing && !input.isEdit) {
      return res.status(409).json({ error: `a server with id "${input.id}" already exists` })
    }
    if (!existing && input.isEdit) {
      return res.status(404).json({ error: `no server with id "${input.id}" exists to edit` })
    }

    if (input.jumpChain && input.jumpChain.length > 0) {
      try {
        resolveJumpPath(input.id, input.jumpChain, (id) => opts.registry.get(id))
      } catch (err: any) {
        return res.status(400).json({ error: err?.message ?? String(err) })
      }
    }

    const record = opts.registry.upsert({
      id: input.id, host: input.host, port: input.port, username: input.username,
      authMethod: input.authMethod, keyPath: input.keyPath, jumpChain: input.jumpChain,
    })
    let priorSecret: string | undefined
    try {
      priorSecret = existing ? opts.keychain.getSecret(input.id) : undefined
      const secretToStore = input.secret || priorSecret
      if (!secretToStore) throw new Error('missing secret')
      opts.keychain.setSecret(input.id, secretToStore)
    } catch (err: any) {
      if (existing) {
        opts.registry.upsert({
          id: existing.id, host: existing.host, port: existing.port, username: existing.username,
          authMethod: existing.authMethod, keyPath: existing.keyPath, jumpChain: existing.jumpChain,
        })
        if (priorSecret !== undefined) opts.keychain.setSecret(existing.id, priorSecret)
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
    const committed: Array<{ id: string; priorRecord: ServerRecord | undefined; priorSecret: string | undefined }> = []
    try {
      for (const input of valid) {
        const priorRecord = opts.registry.get(input.id)
        const priorSecret = priorRecord ? opts.keychain.getSecret(input.id) : undefined
        opts.registry.upsert({
          id: input.id, host: input.host, port: input.port, username: input.username,
          authMethod: input.authMethod, keyPath: input.keyPath,
        })
        committed.push({ id: input.id, priorRecord, priorSecret })
        opts.keychain.setSecret(input.id, input.secret)
        succeeded.push(input.id)
      }
    } catch (err: any) {
      for (const { id, priorRecord, priorSecret } of committed) {
        if (priorRecord) {
          opts.registry.upsert({
            id: priorRecord.id, host: priorRecord.host, port: priorRecord.port, username: priorRecord.username,
            authMethod: priorRecord.authMethod, keyPath: priorRecord.keyPath,
          })
          if (priorSecret !== undefined) opts.keychain.setSecret(priorRecord.id, priorSecret)
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

  app.post('/api/servers/:id/test', async (req, res) => {
    if (!opts.sshManager) return res.status(501).json({ error: 'connection testing is not available' })
    const server = opts.registry.get(req.params.id)
    if (!server) return res.status(404).json({ error: `unknown server: ${req.params.id}` })
    try {
      await opts.sshManager.testConnect(server)
      res.json({ ok: true })
    } catch (err: any) {
      res.json({ ok: false, error: sanitizeSshError(err) })
    }
  })

  app.post('/api/servers/test', async (req, res) => {
    if (!opts.sshManager) return res.status(501).json({ error: 'connection testing is not available' })
    const input: ServerInput = req.body
    const existing = input.id ? opts.registry.get(input.id) : undefined
    const error = validateServerInput({ ...input, isEdit: Boolean(existing && !input.secret) })
    if (error) return res.status(400).json({ error })

    if (input.jumpChain && input.jumpChain.length > 0) {
      try {
        resolveJumpPath(input.id, input.jumpChain, (id) => opts.registry.get(id))
      } catch (err: any) {
        return res.status(400).json({ error: err?.message ?? String(err) })
      }
    }

    let secret: string | undefined
    try {
      secret = input.secret || (existing ? opts.keychain.getSecret(input.id) : undefined)
    } catch {
      // Keychain lookup can throw if the secret was never stored (or was deleted) —
      // treat that the same as "no secret provided" rather than crashing the request.
      secret = undefined
    }
    if (!secret) return res.status(400).json({ error: 'missing secret' })

    const record: ServerRecord = {
      id: input.id, host: input.host, port: input.port, username: input.username,
      authMethod: input.authMethod, keyPath: input.keyPath, jumpChain: input.jumpChain,
      createdAt: 0, updatedAt: 0,
    }
    try {
      await opts.sshManager.testConnect(record, secret)
      res.json({ ok: true })
    } catch (err: any) {
      res.json({ ok: false, error: sanitizeSshError(err) })
    }
  })

  app.post('/api/servers/test-all', (_req, res) => {
    if (!opts.sshManager) return res.status(501).json({ error: 'connection testing is not available' })
    const servers = opts.registry.list()
    res.status(202).json({ count: servers.length })
    for (const server of servers) {
      opts.sshManager
        .testConnect(server)
        .then(() => broadcast({ type: 'server_test_result', id: server.id, ok: true }))
        .catch((err: any) => broadcast({ type: 'server_test_result', id: server.id, ok: false, error: sanitizeSshError(err) }))
    }
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
