import { describe, it, expect, vi } from 'vitest'
import { SshManager } from '../../src/daemon/ssh-manager.js'
import type { ServerRecord } from '../../src/shared/types.js'
import { EventEmitter } from 'node:events'

const server: ServerRecord = {
  id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy',
  authMethod: 'password', createdAt: 0, updatedAt: 0,
}

function fakeExecChannel() {
  const channel = new EventEmitter() as any
  channel.stderr = new EventEmitter()
  return channel
}

describe('SshManager', () => {
  it('exec resolves the secret, connects, runs the command, and resolves with the exit code', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('data', Buffer.from('hello\n'))
          channel.emit('close', 0)
        })
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const resolver = vi.fn().mockReturnValue('hunter2')
    const mgr = new SshManager(resolver, connectFn as any)

    const chunks: string[] = []
    const exitCode = await mgr.exec(server, 'ls -la', (_s, chunk) => chunks.push(chunk))

    expect(resolver).toHaveBeenCalledWith('srv-a1')
    expect(connectFn).toHaveBeenCalledWith(server, 'hunter2', expect.any(Object))
    expect(chunks).toEqual(['hello\n'])
    expect(exitCode).toBe(0)
  })

  it('exec forwards stderr chunks on the "stderr" stream', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.stderr.emit('data', Buffer.from('warn: thing\n'))
          channel.emit('close', 1)
        })
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const events: Array<[string, string]> = []
    const exitCode = await mgr.exec(server, 'false', (s, chunk) => events.push([s, chunk]))

    expect(events).toEqual([['stderr', 'warn: thing\n']])
    expect(exitCode).toBe(1)
  })

  it('startSession connects and returns a session id; sendToSession writes to the channel', async () => {
    const channel = fakeExecChannel()
    channel.write = vi.fn()
    const fakeClient = {
      shell: vi.fn((cb: (err: any, channel: any) => void) => cb(null, channel)),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const sessionId = await mgr.startSession(server, () => {})
    expect(typeof sessionId).toBe('string')

    mgr.sendToSession(sessionId, 'echo hi\n')
    expect(channel.write).toHaveBeenCalledWith('echo hi\n')
  })

  it('stopSession ends the channel and prevents further sendToSession calls', async () => {
    const channel = fakeExecChannel()
    channel.write = vi.fn()
    channel.end = vi.fn()
    const fakeClient = { shell: vi.fn((cb: (err: any, channel: any) => void) => cb(null, channel)) }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const sessionId = await mgr.startSession(server, () => {})
    mgr.stopSession(sessionId)
    expect(channel.end).toHaveBeenCalled()
    expect(mgr.hasSession(sessionId)).toBe(false)
    expect(() => mgr.sendToSession(sessionId, 'x')).toThrow()
  })

  it('passes HostKeyStore to connectFn for host-key verification', async () => {
    const channel = fakeExecChannel()
    let capturedHostKeyStore: any = null
    const fakeClient = {
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('close', 0)
        })
      }),
    }
    const connectFn = vi.fn(async (_server: ServerRecord, _secret: string, hostKeyStore?: any) => {
      capturedHostKeyStore = hostKeyStore
      return fakeClient
    })
    const mgr = new SshManager(() => 'secret', connectFn as any)

    await mgr.exec(server, 'true', () => {})

    expect(capturedHostKeyStore).toBeDefined()
    expect(typeof capturedHostKeyStore.get).toBe('function')
    expect(typeof capturedHostKeyStore.set).toBe('function')
  })
})
