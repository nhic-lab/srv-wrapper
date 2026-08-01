import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
      end: () => {},
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

function connectAndSend(payload: object, resolveOn: string = 'done'): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath)
    const received: any[] = []
    conn.on('connect', () => conn.write(JSON.stringify(payload) + '\n'))
    conn.on('data', (buf) => {
      for (const line of buf.toString().split('\n').filter(Boolean)) {
        const msg = JSON.parse(line)
        received.push(msg)
        if (msg.type === resolveOn) {
          conn.end()
          resolve(received)
        }
      }
    })
    conn.on('error', reject)
  })
}

describe('SocketServer', () => {
  it('restricts the socket file to owner-only permissions after starting', async () => {
    const stats = fs.statSync(socketPath)
    expect(stats.mode & 0o777).toBe(0o600)
  })

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

  it('surfaces a synchronous throw inside handleMessage as a done error instead of crashing', async () => {
    vi.spyOn(registry, 'get').mockImplementation(() => {
      throw new Error('boom')
    })
    const events = await connectAndSend({ type: 'exec', serverId: 'srv-a1', agentLabel: 'a', command: 'x', requestId: 'req-4' })
    const done = events.find((e) => e.type === 'done')
    expect(done.error).toMatch(/boom/)
  })

  it('sanitizes an SSH-layer connection error so the raw host/port never reaches the client or the log store', async () => {
    const leakyError: any = new Error('connect ECONNREFUSED 10.0.0.5:22')
    leakyError.code = 'ECONNREFUSED'

    const leakySshManager = new SshManager(
      () => 'secret',
      async () => {
        throw leakyError
      }
    )
    await server.stop()
    server = new SocketServer({ socketPath, registry, logStore, sshManager: leakySshManager })
    await server.start()

    const events = await connectAndSend({
      type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-6',
    })
    const done = events.find((e) => e.type === 'done')
    expect(done.error).not.toContain('10.0.0.5')
    expect(done.error).not.toContain('22')
    expect(done.error).toMatch(/connection refused/i)

    const runs = logStore.list({ serverId: 'srv-a1' })
    const serialized = JSON.stringify(runs)
    expect(serialized).not.toContain('10.0.0.5')
  })

  it('does not crash on a malformed JSON line, and later connections still work', async () => {
    await new Promise<void>((resolve, reject) => {
      const conn = createConnection(socketPath)
      conn.on('connect', () => {
        conn.write('not json at all\n')
        setTimeout(() => {
          conn.end()
          resolve()
        }, 50)
      })
      conn.on('error', reject)
    })

    const events = await connectAndSend({
      type: 'exec', serverId: 'srv-a1', agentLabel: 'test-agent', command: 'echo ok', requestId: 'req-5',
    })
    const done = events.find((e) => e.type === 'done')
    expect(done.exitCode).toBe(0)
  })

  it('handles a full session_start -> session_send -> session_stop flow', async () => {
    // Rebuild sshManager with both exec and shell support for this test
    const { EventEmitter } = await import('node:events')
    const channel: any = new EventEmitter()
    channel.stderr = new EventEmitter()
    channel.write = (data: string) => {
      queueMicrotask(() => channel.emit('data', Buffer.from(`echo of: ${data}`)))
    }
    channel.end = () => channel.emit('close')

    const sessionSshManager = new SshManager(
      () => 'secret',
      async () => ({ end: () => {}, shell: (cb: (err: any, ch: any) => void) => cb(null, channel) })
    )
    await server.stop()
    server = new SocketServer({ socketPath, registry, logStore, sshManager: sessionSshManager })
    await server.start()

    const startEvents = await connectAndSend({ type: 'session_start', serverId: 'srv-a1', agentLabel: 'agent-x', requestId: 'r1' }, 'session_started')
    const sessionId = startEvents.find((e) => e.type === 'session_started').sessionId
    expect(typeof sessionId).toBe('string')

    const sendEvents = await connectAndSend({ type: 'session_send', sessionId, command: 'ls\n', requestId: 'r2' }, 'done')
    expect(sendEvents.find((e) => e.type === 'stream').chunk).toContain('echo of: ls')

    const stopEvents = await connectAndSend({ type: 'session_stop', sessionId, requestId: 'r3' }, 'done')
    expect(stopEvents.find((e) => e.type === 'done')).toBeDefined()

    const runs = logStore.list({ agentLabel: 'agent-x' })
    expect(runs).toHaveLength(1)
    expect(runs[0].kind).toBe('session')
    expect(runs[0].endedAt).not.toBeNull()
  })

  it('auto-closes a session after 30 minutes of no session_send activity', async () => {
    vi.useFakeTimers()
    try {
      const { EventEmitter } = await import('node:events')
      const channel: any = new EventEmitter()
      channel.stderr = new EventEmitter()
      channel.write = () => {}
      let ended = false
      channel.end = () => { ended = true; channel.emit('close') }

      const sessionSshManager = new SshManager(
        () => 'secret',
        async () => ({ end: () => {}, shell: (cb: (err: any, ch: any) => void) => cb(null, channel) })
      )
      await server.stop()
      server = new SocketServer({ socketPath, registry, logStore, sshManager: sessionSshManager })
      await server.start()

      const startEvents = await connectAndSend({ type: 'session_start', serverId: 'srv-a1', agentLabel: 'agent-x', requestId: 'r1' }, 'session_started')
      const sessionId = startEvents.find((e) => e.type === 'session_started').sessionId

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1000)

      expect(ended).toBe(true)
      const runs = logStore.list({ agentLabel: 'agent-x' })
      expect(runs[0].endedAt).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the previous idleTimer instead of leaking it when a second session_send arrives before the first one idles out', async () => {
    const { EventEmitter } = await import('node:events')
    const channel: any = new EventEmitter()
    channel.stderr = new EventEmitter()
    channel.write = () => {}
    channel.end = () => channel.emit('close')

    const sessionSshManager = new SshManager(
      () => 'secret',
      async () => ({ end: () => {}, shell: (cb: (err: any, ch: any) => void) => cb(null, channel) })
    )
    await server.stop()
    server = new SocketServer({ socketPath, registry, logStore, sshManager: sessionSshManager })
    await server.start()

    const startEvents = await connectAndSend({ type: 'session_start', serverId: 'srv-a1', agentLabel: 'agent-x', requestId: 'r1' }, 'session_started')
    const sessionId = startEvents.find((e) => e.type === 'session_started').sessionId

    // First send: fire-and-forget (channel.write is silent, so no 'stream'/'done' will ever
    // arrive on this connection unless its idleTimer is left to fire on its own).
    const conn1 = createConnection(socketPath)
    await new Promise<void>((resolve) => {
      conn1.on('connect', () => {
        conn1.write(JSON.stringify({ type: 'session_send', sessionId, command: 'ls\n', requestId: 'r2' }) + '\n')
        resolve()
      })
    })
    await new Promise((r) => setTimeout(r, 20))

    const firstIdleTimer = (server as any).sessions.get(sessionId).idleTimer
    expect(firstIdleTimer).not.toBeNull()

    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    await connectAndSend({ type: 'session_send', sessionId, command: 'pwd\n', requestId: 'r3' }, 'done')

    expect(clearTimeoutSpy.mock.calls.some((call) => call[0] === firstIdleTimer)).toBe(true)
    clearTimeoutSpy.mockRestore()
    conn1.destroy()
  })
})
