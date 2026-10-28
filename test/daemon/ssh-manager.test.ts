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

const { SshManager, RegistryHostKeyStore, CommandTimeoutError, checkReachable } = await import('../../src/daemon/ssh-manager.js')
const { Registry } = await import('../../src/daemon/registry.js')
const { buildSudoExecCommand, SudoError } = await import('../../src/daemon/sudo.js')
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
    expect(connectFn).toHaveBeenCalledWith(server, 'hunter2', expect.any(Object), undefined, undefined)
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

  it('closes the exec channel\'s stdin immediately so a remote command reading stdin gets EOF instead of hanging', async () => {
    const channel = fakeExecChannel()
    channel.end = vi.fn()
    const fakeClient = {
      end: vi.fn(),
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => channel.emit('close', 0))
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    await mgr.exec(server, 'cat', () => {})

    expect(channel.end).toHaveBeenCalled()
  })

  it('rejects with CommandTimeoutError and tears down the connection if the command outlives timeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const channel = fakeExecChannel()
      channel.end = vi.fn()
      const fakeClient = {
        end: vi.fn(),
        exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
          cb(null, channel)
          // Never closes — simulates a hung/long-running remote command.
        }),
      }
      const connectFn = vi.fn().mockResolvedValue(fakeClient)
      const mgr = new SshManager(() => 'secret', connectFn as any)

      const promise = mgr.exec(server, 'sleep 999', () => {}, 5000)
      const assertion = expect(promise).rejects.toThrow(CommandTimeoutError)
      await vi.advanceTimersByTimeAsync(5000)
      await assertion
      expect(fakeClient.end).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves normally when the command finishes before timeoutMs elapses', async () => {
    const channel = fakeExecChannel()
    channel.end = vi.fn()
    const fakeClient = {
      end: vi.fn(),
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => channel.emit('close', 0))
      }),
    }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const mgr = new SshManager(() => 'secret', connectFn as any)

    await expect(mgr.exec(server, 'true', () => {}, 60000)).resolves.toBe(0)
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

describe('SshManager.testConnect', () => {
  it('resolves the secret via the resolver, connects, and immediately closes the client', async () => {
    const fakeClient = { end: vi.fn() }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const resolver = vi.fn().mockReturnValue('hunter2')
    const mgr = new SshManager(resolver, connectFn as any)

    await mgr.testConnect(server)

    expect(resolver).toHaveBeenCalledWith('srv-a1')
    expect(connectFn).toHaveBeenCalledWith(server, 'hunter2', expect.any(Object), undefined, 8000)
    expect(fakeClient.end).toHaveBeenCalled()
  })

  it('uses secretOverride instead of the resolver when testing an unsaved server', async () => {
    const fakeClient = { end: vi.fn() }
    const connectFn = vi.fn().mockResolvedValue(fakeClient)
    const resolver = vi.fn().mockReturnValue('should-not-be-used')
    const mgr = new SshManager(resolver, connectFn as any)

    await mgr.testConnect(server, 'typed-in-form-secret')

    expect(resolver).not.toHaveBeenCalled()
    expect(connectFn).toHaveBeenCalledWith(server, 'typed-in-form-secret', expect.any(Object), undefined, 8000)
    expect(fakeClient.end).toHaveBeenCalled()
  })

  it('rejects and closes nothing further when the connection fails', async () => {
    const connectFn = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))
    const mgr = new SshManager(() => 'secret', connectFn as any)

    await expect(mgr.testConnect(server)).rejects.toThrow('connect ECONNREFUSED')
  })
})

describe('SshManager jump chain connecting', () => {
  const bastion1: ServerRecord = {
    id: 'bastion-1', host: '10.0.0.1', port: 22, username: 'deploy',
    authMethod: 'password', createdAt: 0, updatedAt: 0,
  }
  const bastion2: ServerRecord = {
    id: 'bastion-2', host: '10.0.0.2', port: 22, username: 'deploy',
    authMethod: 'password', createdAt: 0, updatedAt: 0,
  }
  const target: ServerRecord = {
    id: 'target-1', host: '10.0.0.9', port: 22, username: 'deploy',
    authMethod: 'password', jumpChain: ['bastion-1', 'bastion-2'], createdAt: 0, updatedAt: 0,
  }

  function makeFakeClient(name: string) {
    const channel = fakeExecChannel()
    return {
      name,
      end: vi.fn(),
      forwardOut: vi.fn((_srcIp: string, _srcPort: number, dstHost: string, dstPort: number, cb: (err: any, stream: any) => void) => {
        cb(null, { fakeStream: true, dstHost, dstPort })
      }),
      exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => {
        cb(null, channel)
        queueMicrotask(() => channel.emit('close', 0))
      }),
    }
  }

  function makeLookup() {
    const registryMap = new Map<string, ServerRecord>([
      ['bastion-1', bastion1],
      ['bastion-2', bastion2],
    ])
    return (id: string) => registryMap.get(id)
  }

  it('connects hop-by-hop via forwardOut, calling connectFn with a tunneled stream for each hop after the first', async () => {
    const clients: Record<string, any> = {
      'bastion-1': makeFakeClient('bastion-1'),
      'bastion-2': makeFakeClient('bastion-2'),
      'target-1': makeFakeClient('target-1'),
    }
    const connectFn = vi.fn(async (rec: ServerRecord, _secret: string, _hostKeyStore: any, viaStream?: any) => {
      if (rec.id === 'bastion-1') {
        expect(viaStream).toBeUndefined()
      } else {
        expect(viaStream).toBeDefined()
      }
      return clients[rec.id]
    })
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    const exitCode = await mgr.exec(target, 'true', () => {})

    expect(exitCode).toBe(0)
    expect(connectFn).toHaveBeenCalledTimes(3)
    expect(clients['bastion-1'].forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '10.0.0.2', 22, expect.any(Function))
    expect(clients['bastion-2'].forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '10.0.0.9', 22, expect.any(Function))
    // Cleanup unwinds target first, back to the first hop.
    expect(clients['target-1'].end).toHaveBeenCalled()
    expect(clients['bastion-2'].end).toHaveBeenCalled()
    expect(clients['bastion-1'].end).toHaveBeenCalled()
  })

  it('closes every intermediate client (in reverse order) even when the exec fails on the target hop', async () => {
    const clients: Record<string, any> = {
      'bastion-1': makeFakeClient('bastion-1'),
      'target-1': {
        end: vi.fn(),
        exec: vi.fn((_cmd: string, cb: (err: any, channel: any) => void) => cb(new Error('exec failed'), null)),
      },
    }
    const soloTarget: ServerRecord = { ...target, jumpChain: ['bastion-1'] }
    const connectFn = vi.fn(async (rec: ServerRecord) => clients[rec.id])
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    await expect(mgr.exec(soloTarget, 'true', () => {})).rejects.toThrow('exec failed')
    expect(clients['target-1'].end).toHaveBeenCalled()
    expect(clients['bastion-1'].end).toHaveBeenCalled()
  })

  it('closes already-connected earlier hops if a later hop fails to connect (e.g. auth failure partway through the chain)', async () => {
    const bastion1Client = makeFakeClient('bastion-1')
    const connectFn = vi.fn(async (rec: ServerRecord) => {
      if (rec.id === 'bastion-1') return bastion1Client
      throw new Error('auth failed for bastion-2')
    })
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    await expect(mgr.exec(target, 'true', () => {})).rejects.toThrow('auth failed for bastion-2')
    expect(bastion1Client.end).toHaveBeenCalled()
  })

  it('rejects with a clear error when the jumpChain references an unregistered server id', async () => {
    const badTarget: ServerRecord = { ...target, jumpChain: ['ghost-host'] }
    const connectFn = vi.fn()
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, () => undefined)

    await expect(mgr.exec(badTarget, 'true', () => {})).rejects.toThrow(/unknown server id "ghost-host"/)
    expect(connectFn).not.toHaveBeenCalled()
  })

  it('rejects when the jumpChain would create a cycle', async () => {
    const selfRefTarget: ServerRecord = { ...target, jumpChain: ['target-1'] }
    const connectFn = vi.fn()
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    await expect(mgr.exec(selfRefTarget, 'true', () => {})).rejects.toThrow(/cycle/)
    expect(connectFn).not.toHaveBeenCalled()
  })

  it('startSession/stopSession keep every hop client alive until stopSession, then close them all in reverse', async () => {
    const sessionChannel = fakeExecChannel()
    sessionChannel.write = vi.fn()
    sessionChannel.end = vi.fn()
    const clients: Record<string, any> = {
      'bastion-1': makeFakeClient('bastion-1'),
      'target-1': {
        end: vi.fn(),
        shell: vi.fn((cb: (err: any, ch: any) => void) => cb(null, sessionChannel)),
      },
    }
    const soloTarget: ServerRecord = { ...target, jumpChain: ['bastion-1'] }
    const connectFn = vi.fn(async (rec: ServerRecord) => clients[rec.id])
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    const sessionId = await mgr.startSession(soloTarget, () => {})
    mgr.sendToSession(sessionId, 'echo hi\n')
    expect(sessionChannel.write).toHaveBeenCalledWith('echo hi\n')
    expect(clients['bastion-1'].end).not.toHaveBeenCalled()
    expect(clients['target-1'].end).not.toHaveBeenCalled()

    mgr.stopSession(sessionId)
    expect(sessionChannel.end).toHaveBeenCalled()
    expect(clients['target-1'].end).toHaveBeenCalled()
    expect(clients['bastion-1'].end).toHaveBeenCalled()
  })

  it('startShell through a jump chain opens the shell on the last hop only and unwinds every hop on close', async () => {
    const shellChannel = fakeExecChannel()
    shellChannel.write = vi.fn(); shellChannel.end = vi.fn(); shellChannel.setWindow = vi.fn()
    const clients: Record<string, any> = {
      'bastion-1': makeFakeClient('bastion-1'),
      'target-1': { end: vi.fn(), shell: vi.fn((_opts: any, cb: (err: any, ch: any) => void) => cb(null, shellChannel)) },
    }
    const soloTarget: ServerRecord = { ...target, jumpChain: ['bastion-1'] }
    const connectFn = vi.fn(async (rec: ServerRecord) => clients[rec.id])
    const mgr = new SshManager(() => 'secret', connectFn as any, undefined, makeLookup())

    const handle = await mgr.startShell(soloTarget, { cols: 80, rows: 24 }, () => {}, () => {})
    expect(connectFn).toHaveBeenCalledTimes(2)
    expect(clients['target-1'].shell).toHaveBeenCalledTimes(1)
    handle.close()
    expect(clients['target-1'].end).toHaveBeenCalled()
    expect(clients['bastion-1'].end).toHaveBeenCalled()
  })
})

describe('checkReachable', () => {
  it('resolves when a TCP connection to host:port succeeds', async () => {
    const net = await import('node:net')
    const server = net.createServer((sock) => sock.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    try {
      await expect(checkReachable('127.0.0.1', port)).resolves.toBeUndefined()
    } finally {
      server.close()
    }
  })

  it('rejects with ECONNREFUSED when nothing is listening on the port', async () => {
    await expect(checkReachable('127.0.0.1', 1)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
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
  it('exec with sudoPassword wraps the command, writes the password to stdin then ends it, and never puts the password in the command', async () => {
    const channel = fakeExecChannel()
    const writes: string[] = []
    channel.write = vi.fn((s: string) => writes.push(s))
    channel.end = vi.fn(() => { expect(writes).toEqual(['hunter2\n']) })
    let seenCmd = ''
    const fakeClient = {
      end: vi.fn(),
      exec: vi.fn((cmd: string, cb: (err: any, channel: any) => void) => {
        seenCmd = cmd
        cb(null, channel)
        queueMicrotask(() => channel.emit('close', 0))
      }),
    }
    const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
    await mgr.exec(server, 'whoami', () => {}, undefined, { sudoPassword: 'hunter2' })
    expect(seenCmd).toBe(buildSudoExecCommand('whoami'))
    expect(seenCmd).not.toContain('hunter2')
    expect(channel.end).toHaveBeenCalledTimes(1)
  })
  describe('session sudo priming', () => {
    /** A fake PTY shell: echoes every written line back, then runs `script` to produce the rest. */
    function fakeShell(script: (written: string, writes: string[], emit: (s: string) => void) => void) {
      const channel = new EventEmitter() as any
      const writes: string[] = []
      channel.end = vi.fn()
      channel.write = (s: string) => {
        writes.push(s)
        queueMicrotask(() => script(s, writes, (out) => channel.emit('data', Buffer.from(out))))
      }
      const fakeClient = { end: vi.fn(), shell: vi.fn((cb: any) => cb(null, channel)) }
      return { channel, writes, fakeClient }
    }
    const tokenOf = (primerLine: string) => primerLine.match(/__srv_sudo''_(.+?)__/)![1]

    it('writes the primer line, sends the password only after the joined prompt sentinel, hides priming output, then forwards the rest', async () => {
      const { channel, writes, fakeClient } = fakeShell((s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) {
          emit(s)                                   // PTY echo of the split-sentinel line
          emit(`__srv_sudo_${tokenOf(all[0])}__`)   // sudo's prompt, joined
        } else if (all.length === 2) {
          emit(`\r\n__srv_done_${tokenOf(all[0])}__0\r\n$ `)
        }
      })
      const seen: string[] = []
      const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
      const id = await mgr.startSession(server, (c) => seen.push(c), { sudoPassword: 'hunter2' })
      expect(writes[1]).toBe('hunter2\n')
      expect(seen.join('')).toBe('$ ')
      channel.emit('data', Buffer.from('later\n'))
      expect(seen.join('')).toBe('$ later\n')
      mgr.stopSession(id)
      expect(writes[2]).toBe('sudo -k\n')
      expect(channel.end).toHaveBeenCalled()
    })

    it('never sends the password when the done sentinel arrives without a prompt (NOPASSWD box)', async () => {
      const { writes, fakeClient } = fakeShell((s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) {
          emit(s)
          emit(`__srv_done_${tokenOf(all[0])}__0\n`)
        }
      })
      const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
      const id = await mgr.startSession(server, () => {}, { sudoPassword: 'hunter2' })
      expect(writes).toHaveLength(1)
      expect(mgr.hasSession(id)).toBe(true)
    })

    it('rejects with SudoError and closes every hop client when priming reports a non-zero code', async () => {
      const { channel, fakeClient } = fakeShell((s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) {
          emit(s)
          emit(`__srv_sudo_${tokenOf(all[0])}__`)
        } else if (all.length === 2) {
          emit(`Sorry, try again.\n__srv_done_${tokenOf(all[0])}__1\n`)
        }
      })
      const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
      const err = await mgr.startSession(server, () => {}, { sudoPassword: 'bad' }).catch((e) => e)
      expect(err).toBeInstanceOf(SudoError)
      expect(err.message).toBe('sudo error: authentication failed')
      expect(channel.end).toHaveBeenCalled()
      expect(fakeClient.end).toHaveBeenCalled()
    })

    it('rejects with SudoError when no sentinel arrives within the priming timeout', async () => {
      vi.useFakeTimers()
      try {
        const { channel, fakeClient } = fakeShell(() => {})
        const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
        const pending = mgr.startSession(server, () => {}, { sudoPassword: 'hunter2' })
        const outcome = expect(pending).rejects.toThrow('sudo error: timed out waiting for sudo prompt')
        await vi.advanceTimersByTimeAsync(15_000)
        await outcome
        expect(channel.end).toHaveBeenCalled()
        expect(fakeClient.end).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('startShell with sudoPassword primes sudo before returning the handle and writes sudo -k on close', async () => {
      const { channel, writes, fakeClient } = fakeShell((s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) {
          emit(s)
          emit(`__srv_sudo_${tokenOf(all[0])}__`)
        } else if (all.length === 2) {
          emit(`\r\n__srv_done_${tokenOf(all[0])}__0\r\n$ `)
        }
      })
      fakeClient.shell = vi.fn((_opts: any, cb: any) => cb(null, channel))
      const seen: Buffer[] = []
      const mgr = new SshManager(() => 'login', vi.fn().mockResolvedValue(fakeClient) as any)
      const handle = await mgr.startShell(server, { cols: 80, rows: 24, sudoPassword: 'hunter2' }, (c) => seen.push(c), () => {})
      expect(writes[1]).toBe('hunter2\n')
      expect(Buffer.concat(seen).toString()).toBe('$ ')
      handle.close()
      expect(writes[2]).toBe('sudo -k\n')
      expect(channel.end).toHaveBeenCalled()
    })
  })

  describe('startShell', () => {
    function shellSetup() {
      const channel = fakeExecChannel()
      channel.write = vi.fn(); channel.end = vi.fn(); channel.setWindow = vi.fn()
      const fakeClient = { end: vi.fn(), shell: vi.fn((_opts: any, cb: (err: any, ch: any) => void) => cb(null, channel)) }
      const mgr = new SshManager(() => 'secret', vi.fn().mockResolvedValue(fakeClient) as any)
      return { channel, fakeClient, mgr }
    }

    it('opens a PTY with the requested size and term, forwards output as Buffers, resizes via setWindow, and closes hops', async () => {
      const { channel, fakeClient, mgr } = shellSetup()
      const seen: Buffer[] = []
      const handle = await mgr.startShell(server, { cols: 120, rows: 40 }, (c) => seen.push(c), () => {})
      expect(fakeClient.shell.mock.calls[0][0]).toEqual({ term: 'xterm-256color', cols: 120, rows: 40 })
      const partial = Buffer.from([0xe2, 0x9c])
      channel.emit('data', partial)
      expect(seen[0]).toBe(partial)
      handle.resize(100, 30)
      expect(channel.setWindow).toHaveBeenCalledWith(30, 100, 0, 0)
      handle.write('ls\r')
      expect(channel.write).toHaveBeenCalledWith('ls\r')
      handle.close()
      expect(channel.end).toHaveBeenCalled()
      expect(fakeClient.end).toHaveBeenCalled()
    })

    it('honours an explicit term', async () => {
      const { fakeClient, mgr } = shellSetup()
      await mgr.startShell(server, { cols: 1, rows: 1, term: 'vt100' }, () => {}, () => {})
      expect(fakeClient.shell.mock.calls[0][0].term).toBe('vt100')
    })

    it('calls onClose once when the remote shell ends, and unwinds the chain', async () => {
      const { channel, fakeClient, mgr } = shellSetup()
      const onClose = vi.fn()
      await mgr.startShell(server, { cols: 80, rows: 24 }, () => {}, onClose)
      channel.emit('close')
      channel.emit('close')
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(fakeClient.end).toHaveBeenCalled()
    })

    it('closeAllShells closes every open shell', async () => {
      const { channel, mgr } = shellSetup()
      await mgr.startShell(server, { cols: 80, rows: 24 }, () => {}, () => {})
      mgr.closeAllShells()
      expect(channel.end).toHaveBeenCalled()
    })
  })
})
