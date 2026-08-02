import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let capturedConnectOpts: any = null

vi.mock('ssh2', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeClient extends EventEmitter {
    connect(opts: any) {
      capturedConnectOpts = opts
      queueMicrotask(() => this.emit('ready'))
    }
    end() {}
    exec(_cmd: string, cb: (err: any, channel: any) => void) {
      const channel = new EventEmitter() as any
      channel.stderr = new EventEmitter()
      cb(null, channel)
      queueMicrotask(() => channel.emit('close', 0))
    }
  }
  return { Client: FakeClient }
})

const { SshManager, RegistryHostKeyStore } = await import('../../src/daemon/ssh-manager.js')
const { Registry } = await import('../../src/daemon/registry.js')
type ServerRecord = import('../../src/shared/types.js').ServerRecord

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
      end: vi.fn(),
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
    expect(fakeClient.end).toHaveBeenCalled()
  })

  it('exec forwards stderr chunks on the "stderr" stream', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      end: vi.fn(),
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
    expect(fakeClient.end).toHaveBeenCalled()
  })

  it('rejects the exec promise (instead of hanging or throwing uncaught) when the channel emits an "error" event', async () => {
    const channel = fakeExecChannel()
    const fakeClient = {
      end: vi.fn(),
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => {
          channel.emit('error', new Error('boom'))
        })
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    await expect(mgr.exec(server, 'ls', () => {})).rejects.toThrow('boom')
    expect(fakeClient.end).toHaveBeenCalled()
  })

  it('startSession connects and returns a session id; sendToSession writes to the channel', async () => {
    const channel = fakeExecChannel()
    channel.write = vi.fn()
    const fakeClient = {
      end: vi.fn(),
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
    const fakeClient = { end: vi.fn(), shell: vi.fn((cb: (err: any, channel: any) => void) => cb(null, channel)) }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    const sessionId = await mgr.startSession(server, () => {})
    mgr.stopSession(sessionId)
    expect(channel.end).toHaveBeenCalled()
    expect(fakeClient.end).toHaveBeenCalled()
    expect(mgr.hasSession(sessionId)).toBe(false)
    expect(() => mgr.sendToSession(sessionId, 'x')).toThrow()
  })

  it('passes HostKeyStore to connectFn for host-key verification', async () => {
    const channel = fakeExecChannel()
    let capturedHostKeyStore: any = null
    const fakeClient = {
      end: vi.fn(),
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

describe('RegistryHostKeyStore', () => {
  let dbPath: string
  let registry: Registry

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-hostkey-test-')), 'registry.db')
    registry = new Registry(dbPath)
    registry.upsert({ id: 'srv-a1', host: '10.0.0.5', port: 22, username: 'deploy', authMethod: 'password' })
  })

  afterEach(() => {
    registry.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  it('persists a fingerprint across separate RegistryHostKeyStore instances backed by the same database', () => {
    const store1 = new RegistryHostKeyStore(registry)
    store1.set('srv-a1', 'SHA256:abc123fingerprint')

    // A brand new Registry instance opening the same on-disk db, wrapped in a
    // brand new RegistryHostKeyStore, proves the pin was actually persisted -
    // not just held in store1's own memory.
    const registry2 = new Registry(dbPath)
    const store2 = new RegistryHostKeyStore(registry2)
    expect(store2.get('srv-a1')).toBe('SHA256:abc123fingerprint')
    registry2.close()
  })

  it('returns undefined for a server with no pinned fingerprint yet', () => {
    const store = new RegistryHostKeyStore(registry)
    expect(store.get('srv-a1')).toBeUndefined()
  })
})

describe('defaultConnect (key-based auth)', () => {
  it('reads the private key file from keyPath and passes privateKey/passphrase (not password) to ssh2', async () => {
    const sshDir = path.join(os.homedir(), '.ssh')
    const keyPath = path.join(sshDir, 'id_rsa')
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: any) => (p === sshDir ? sshDir : keyPath)) as any)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('FAKE_PRIVATE_KEY_CONTENTS' as any)
    try {
      const keyServer: ServerRecord = {
        id: 'srv-key1', host: '10.0.0.9', port: 22, username: 'deploy',
        authMethod: 'key', keyPath, createdAt: 0, updatedAt: 0,
      }
      const mgr = new SshManager(() => 'my-passphrase')

      await mgr.exec(keyServer, 'true', () => {})

      expect(readSpy).toHaveBeenCalledWith(keyPath, 'utf-8')
      expect(capturedConnectOpts.privateKey).toBe('FAKE_PRIVATE_KEY_CONTENTS')
      expect(capturedConnectOpts.passphrase).toBe('my-passphrase')
      expect(capturedConnectOpts.password).toBeUndefined()
    } finally {
      readSpy.mockRestore()
      realpathSpy.mockRestore()
    }
  })

  it('rejects a keyPath that resolves outside ~/.ssh', async () => {
    const sshDir = path.join(os.homedir(), '.ssh')
    const outsidePath = '/etc/passwd'
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: any) => (p === sshDir ? sshDir : outsidePath)) as any)
    try {
      const keyServer: ServerRecord = {
        id: 'srv-key2', host: '10.0.0.9', port: 22, username: 'deploy',
        authMethod: 'key', keyPath: outsidePath, createdAt: 0, updatedAt: 0,
      }
      const mgr = new SshManager(() => 'my-passphrase')

      await expect(mgr.exec(keyServer, 'true', () => {})).rejects.toThrow(/must be inside ~\/\.ssh/)
    } finally {
      realpathSpy.mockRestore()
    }
  })

  it('rejects a keyPath that resolves to a symlink target outside ~/.ssh', async () => {
    const sshDir = path.join(os.homedir(), '.ssh')
    const symlinkInSsh = path.join(sshDir, 'sneaky_link')
    const realTargetOutside = '/etc/shadow'
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: any) => (p === sshDir ? sshDir : realTargetOutside)) as any)
    try {
      const keyServer: ServerRecord = {
        id: 'srv-key3', host: '10.0.0.9', port: 22, username: 'deploy',
        authMethod: 'key', keyPath: symlinkInSsh, createdAt: 0, updatedAt: 0,
      }
      const mgr = new SshManager(() => 'my-passphrase')

      await expect(mgr.exec(keyServer, 'true', () => {})).rejects.toThrow(/must be inside ~\/\.ssh/)
    } finally {
      realpathSpy.mockRestore()
    }
  })
})
