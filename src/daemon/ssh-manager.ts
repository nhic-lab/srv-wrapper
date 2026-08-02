import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerRecord } from '../shared/types.js'
import type { Registry } from './registry.js'

export interface HostKeyStore {
  get(serverId: string): string | undefined
  set(serverId: string, fingerprint: string): void
}

export class InMemoryHostKeyStore implements HostKeyStore {
  private fingerprints = new Map<string, string>()
  get(serverId: string): string | undefined {
    return this.fingerprints.get(serverId)
  }
  set(serverId: string, fingerprint: string): void {
    this.fingerprints.set(serverId, fingerprint)
  }
}

/**
 * Persists TOFU host-key pinning in the Registry's sqlite database so pins
 * survive daemon restarts (launchd restarts the daemon on login/crash).
 */
export class RegistryHostKeyStore implements HostKeyStore {
  constructor(private registry: Registry) {}
  get(serverId: string): string | undefined {
    return this.registry.get(serverId)?.hostKeyFingerprint
  }
  set(serverId: string, fingerprint: string): void {
    this.registry.setHostKeyFingerprint(serverId, fingerprint)
  }
}

export type ConnectFn = (server: ServerRecord, secret: string, hostKeyStore?: HostKeyStore) => Promise<any>

/**
 * Reads a private key file, restricted to ~/.ssh so a malicious or mistaken
 * keyPath value (registered via the dashboard) can't be used to read arbitrary
 * files on the machine. realpathSync resolves the full symlink chain first,
 * so a symlink inside ~/.ssh pointing outside it is rejected too.
 */
function readPrivateKeyFile(keyPath: string): string {
  const sshDir = fs.realpathSync(path.join(os.homedir(), '.ssh'))
  let resolved: string
  try {
    resolved = fs.realpathSync(keyPath)
  } catch {
    throw new Error(`key file not found: ${keyPath}`)
  }
  if (resolved !== sshDir && !resolved.startsWith(sshDir + path.sep)) {
    throw new Error(`key path must be inside ~/.ssh (got: ${keyPath})`)
  }
  return fs.readFileSync(resolved, 'utf-8')
}

function defaultConnect(server: ServerRecord, secret: string, hostKeyStore?: HostKeyStore): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    let authOpts: Record<string, unknown>
    if (server.authMethod === 'password') {
      authOpts = { password: secret }
    } else {
      if (!server.keyPath) throw new Error('keyPath is required for key-based authentication')
      authOpts = { privateKey: readPrivateKeyFile(server.keyPath), passphrase: secret }
    }

    const connectOpts: Record<string, unknown> = { host: server.host, port: server.port, username: server.username, ...authOpts }
    if (hostKeyStore) {
      connectOpts.hostHash = 'sha256'
      connectOpts.hostVerifier = (fingerprint: string) => {
        const expected = hostKeyStore.get(server.id)
        if (!expected) {
          hostKeyStore.set(server.id, fingerprint)
          return true
        }
        return expected === fingerprint
      }
    }
    client.connect(connectOpts as any)
  })
}

interface OpenSession {
  client: any
  channel: any
}

export class SshManager {
  private sessions = new Map<string, OpenSession>()

  constructor(
    private secretResolver: (serverId: string) => string,
    private connectFn: ConnectFn = defaultConnect,
    private hostKeyStore: HostKeyStore = new InMemoryHostKeyStore()
  ) {}

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  async exec(
    server: ServerRecord,
    command: string,
    onData: (stream: 'stdout' | 'stderr', chunk: string) => void
  ): Promise<number> {
    const secret = this.secretResolver(server.id)
    const client = await this.connectFn(server, secret, this.hostKeyStore)

    return new Promise((resolve, reject) => {
      let settled = false
      client.exec(command, (err: any, channel: any) => {
        if (err) {
          settled = true
          client.end()
          return reject(err)
        }
        channel.on('data', (data: Buffer) => onData('stdout', data.toString()))
        channel.stderr.on('data', (data: Buffer) => onData('stderr', data.toString()))
        channel.on('close', (code: number) => {
          if (settled) return
          settled = true
          client.end()
          resolve(code)
        })
        channel.on('error', (chanErr: any) => {
          if (settled) return
          settled = true
          client.end()
          reject(chanErr)
        })
      })
    })
  }

  async startSession(server: ServerRecord, onData: (chunk: string) => void): Promise<string> {
    const secret = this.secretResolver(server.id)
    const client = await this.connectFn(server, secret, this.hostKeyStore)

    const channel = await new Promise<any>((resolve, reject) => {
      client.shell((err: any, ch: any) => (err ? reject(err) : resolve(ch)))
    })
    channel.on('data', (data: Buffer) => onData(data.toString()))

    const sessionId = randomUUID()
    channel.on('error', (err: any) => {
      console.error(`srvd: session channel error for ${sessionId}:`, err)
      this.sessions.delete(sessionId)
      try {
        client.end()
      } catch {
        // already closed; nothing to do
      }
    })

    this.sessions.set(sessionId, { client, channel })
    return sessionId
  }

  sendToSession(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`No open session ${sessionId}`)
    session.channel.write(command)
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.channel.end()
    session.client.end()
    this.sessions.delete(sessionId)
  }
}
