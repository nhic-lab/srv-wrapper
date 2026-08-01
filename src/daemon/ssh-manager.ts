import { Client } from 'ssh2'
import { randomUUID } from 'node:crypto'
import type { ServerRecord } from '../shared/types.js'

export type ConnectFn = (server: ServerRecord, secret: string) => Promise<any>

function defaultConnect(server: ServerRecord, secret: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    const authOpts: Record<string, unknown> =
      server.authMethod === 'password' ? { password: secret } : { privateKey: secret }
    client.connect({ host: server.host, port: server.port, username: server.username, ...authOpts })
  })
}

interface OpenSession {
  channel: any
  closed: boolean
}

export class SshManager {
  private sessions = new Map<string, OpenSession>()

  constructor(
    private secretResolver: (serverId: string) => string,
    private connectFn: ConnectFn = defaultConnect
  ) {}

  async exec(
    server: ServerRecord,
    command: string,
    onData: (stream: 'stdout' | 'stderr', chunk: string) => void
  ): Promise<number> {
    const secret = this.secretResolver(server.id)
    const client = await this.connectFn(server, secret)

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
    const client = await this.connectFn(server, secret)

    const channel = await new Promise<any>((resolve, reject) => {
      client.shell((err: any, ch: any) => (err ? reject(err) : resolve(ch)))
    })
    channel.on('data', (data: Buffer) => onData(data.toString()))

    const sessionId = randomUUID()
    this.sessions.set(sessionId, { channel, closed: false })
    return sessionId
  }

  sendToSession(sessionId: string, command: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) throw new Error(`No open session ${sessionId}`)
    session.channel.write(command)
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.channel.end()
    session.closed = true
  }
}
