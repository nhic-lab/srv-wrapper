import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerRecord } from '../shared/types.js'
import type { Registry } from './registry.js'
import { resolveJumpPath } from './jump-chain.js'

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

/**
 * `viaStream`, when present, is a duplex stream obtained from a previous hop's
 * `client.forwardOut(...)` — the connection should be made through it (ssh2's
 * `sock` connect option) instead of `server.host`/`server.port`. It's an
 * optional 4th param so the non-chained call site can keep calling connectFn
 * with exactly 3 positional args, preserving the existing contract/tests.
 */
export type ConnectFn = (
  server: ServerRecord,
  secret: string,
  hostKeyStore?: HostKeyStore,
  viaStream?: any,
  readyTimeoutMs?: number
) => Promise<any>

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

function defaultConnect(server: ServerRecord, secret: string, hostKeyStore?: HostKeyStore, viaStream?: any, readyTimeoutMs?: number): Promise<any> {
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

    const connectOpts: Record<string, unknown> = viaStream
      ? { sock: viaStream, username: server.username, ...authOpts }
      : { host: server.host, port: server.port, username: server.username, ...authOpts }
    if (readyTimeoutMs !== undefined) connectOpts.readyTimeout = readyTimeoutMs
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
  clients: any[]
  channel: any
}

function closeChainClients(clients: any[]): void {
  // Unwind in reverse: target first, back to the first hop.
  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i].end()
    } catch {
      // already closed; nothing to do
    }
  }
}

export class SshManager {
  private static readonly TEST_CONNECT_TIMEOUT_MS = 8000

  private sessions = new Map<string, OpenSession>()

  constructor(
    private secretResolver: (serverId: string) => string,
    private connectFn: ConnectFn = defaultConnect,
    private hostKeyStore: HostKeyStore = new InMemoryHostKeyStore(),
    private serverLookup: (serverId: string) => ServerRecord | undefined = () => undefined
  ) {}

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Connects to `server`, tunneling through its fully-expanded jumpChain (if
   * any) one hop at a time via `client.forwardOut`. Returns every connected
   * Client in hop order, last entry being the connection to `server` itself.
   * When there's no jumpChain this degenerates to a single direct connect.
   *
   * `targetSecretOverride`, when given, supplies the secret for `server`
   * itself instead of `secretResolver` — used by testConnect() to test a
   * not-yet-saved server (whose secret isn't in the Keychain yet). Every
   * other hop in the chain is still an existing registered server, so its
   * secret still comes from the resolver as usual.
   */
  private async connectChain(server: ServerRecord, targetSecretOverride?: string, readyTimeoutMs?: number): Promise<any[]> {
    const hopIds =
      server.jumpChain && server.jumpChain.length > 0
        ? resolveJumpPath(server.id, server.jumpChain, this.serverLookup)
        : [server.id]

    const clients: any[] = []
    try {
      for (let i = 0; i < hopIds.length; i++) {
        const id = hopIds[i]
        const record = id === server.id ? server : this.serverLookup(id)
        if (!record) throw new Error(`jump chain references unknown server id "${id}"`)
        const secret = id === server.id && targetSecretOverride !== undefined ? targetSecretOverride : this.secretResolver(id)

        if (i === 0) {
          clients.push(await this.connectFn(record, secret, this.hostKeyStore, undefined, readyTimeoutMs))
        } else {
          const previousClient = clients[clients.length - 1]
          const stream = await new Promise<any>((resolve, reject) => {
            previousClient.forwardOut('127.0.0.1', 0, record.host, record.port, (err: any, stream: any) => {
              if (err) return reject(err)
              resolve(stream)
            })
          })
          clients.push(await this.connectFn(record, secret, this.hostKeyStore, stream, readyTimeoutMs))
        }
      }
    } catch (err) {
      // A later hop failed (bad auth, unreachable, etc.) — close whatever
      // earlier hops already connected instead of leaking them.
      closeChainClients(clients)
      throw err
    }
    return clients
  }

  /**
   * Opens a connection to `server` (through its jumpChain, if any) and
   * immediately closes it — used to check reachability/credentials without
   * running a command. `secretOverride` lets callers test a server that
   * isn't registered yet (e.g. the dashboard's "test connection" button on
   * an unsaved form), whose secret isn't in the Keychain.
   */
  async testConnect(server: ServerRecord, secretOverride?: string): Promise<void> {
    const clients = await this.connectChain(server, secretOverride, SshManager.TEST_CONNECT_TIMEOUT_MS)
    closeChainClients(clients)
  }

  async exec(
    server: ServerRecord,
    command: string,
    onData: (stream: 'stdout' | 'stderr', chunk: string) => void
  ): Promise<number> {
    const clients = await this.connectChain(server)
    const client = clients[clients.length - 1]

    return new Promise((resolve, reject) => {
      let settled = false
      client.exec(command, (err: any, channel: any) => {
        if (err) {
          settled = true
          closeChainClients(clients)
          return reject(err)
        }
        channel.on('data', (data: Buffer) => onData('stdout', data.toString()))
        channel.stderr.on('data', (data: Buffer) => onData('stderr', data.toString()))
        channel.on('close', (code: number) => {
          if (settled) return
          settled = true
          closeChainClients(clients)
          resolve(code)
        })
        channel.on('error', (chanErr: any) => {
          if (settled) return
          settled = true
          closeChainClients(clients)
          reject(chanErr)
        })
      })
    })
  }

  async startSession(server: ServerRecord, onData: (chunk: string) => void): Promise<string> {
    const clients = await this.connectChain(server)
    const client = clients[clients.length - 1]

    const channel = await new Promise<any>((resolve, reject) => {
      client.shell((err: any, ch: any) => (err ? reject(err) : resolve(ch)))
    })
    channel.on('data', (data: Buffer) => onData(data.toString()))

    const sessionId = randomUUID()
    channel.on('error', (err: any) => {
      console.error(`srvd: session channel error for ${sessionId}:`, err)
      this.sessions.delete(sessionId)
      closeChainClients(clients)
    })

    this.sessions.set(sessionId, { clients, channel })
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
    closeChainClients(session.clients)
    this.sessions.delete(sessionId)
  }
}
