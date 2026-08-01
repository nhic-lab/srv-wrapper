import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { ServerRecord } from '../shared/types.js'

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

export type ConnectFn = (server: ServerRecord, secret: string, hostKeyStore?: HostKeyStore) => Promise<any>

function defaultConnect(server: ServerRecord, secret: string, hostKeyStore?: HostKeyStore): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    const authOpts: Record<string, unknown> =
      server.authMethod === 'password' ? { password: secret } : { privateKey: secret }

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
      client.exec(command, (err: any, channel: any) => {
        if (err) return reject(err)
        channel.on('data', (data: Buffer) => onData('stdout', data.toString()))
        channel.stderr.on('data', (data: Buffer) => onData('stderr', data.toString()))
        channel.on('close', (code: number) => resolve(code))
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
    this.sessions.set(sessionId, { channel })
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
    this.sessions.delete(sessionId)
  }
}
