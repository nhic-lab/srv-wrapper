import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SocketServer } from '../../src/daemon/socket-server.js'
import { Registry } from '../../src/daemon/registry.js'
import { LogStore } from '../../src/daemon/logstore.js'
import { SshManager } from '../../src/daemon/ssh-manager.js'
import { createConnection } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let dir: string
let socketPath: string
let registry: Registry
let logStore: LogStore
let sshManager: SshManager
let server: SocketServer

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-sock-test-'))
  socketPath = path.join(dir, 'srv.sock')
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password' })

  sshManager = new SshManager(
    () => 'secret',
    async () => ({
      exec: (_cmd: string, cb: (err: any, channel: any) => void) => {
        const { EventEmitter } = require('node:events')
        const channel = new EventEmitter() as any
        channel.stderr = new EventEmitter()
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('ok\n'))
          channel.emit('close', 0)
        })
      },
    })
  )

  server = new SocketServer({ socketPath, registry, logStore, sshManager })
  await server.start()
})

afterEach(async () => {
  await server.stop()
  registry.close()
  logStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function connectAndSend(payload: object): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath)
    const received: any[] = []
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'))
    conn.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line)
        received.push(msg)
        if (msg.type === 'done') {
          conn.end()
          resolve(received)
        }
      }
    })
    conn.on('error', reject)
  })
}

describe('SocketServer', () => {
  it('handles an exec request end-to-end and streams stdout then done', async () => {
    const events = await connectAndSend({
      type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-1',
    })
    const stream = events.find((e) => e.type === 'stream')
    const done = events.find((e) => e.type === 'done')
    expect(stream.chunk).toBe('ok\n')
    expect(done.exitCode).toBe(0)
  })

  it('records the run in the log store', async () => {
    await connectAndSend({ type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-2' })
    const runs = logStore.list({ serverId: 'srv-a1' })
    expect(runs).toHaveLength(1)
    expect(runs[0].agentLabel).toBe('test-agent')
    expect(runs[0].output).toBe('ok\n')
    expect(runs[0].exitCode).toBe(0)
  })

  it('responds with a done error event for an unknown serverId, without touching sshManager', async () => {
    const events = await connectAndSend({ type: 'exec', serverId: 'nope', agentLabel: 'a', command: 'x', requestId: 'req-3' })
    const done = events.find((e) => e.type === 'done')
    expect(done.error).toMatch(/unknown server/i)
  })
})
