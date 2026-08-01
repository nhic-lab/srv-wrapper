import net from 'node:net'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from './socket-protocol.js'
import type { Registry } from './registry.js'
import type { LogStore } from './logstore.js'
import type { SshManager } from './ssh-manager.js'
import type { DaemonEvent } from '../shared/types.js'

interface SocketServerOptions {
  socketPath: string
  registry: Registry
  logStore: LogStore
  sshManager: SshManager
  onBroadcast?: (event: DaemonEvent & { requestId: string; serverId?: string; agentLabel?: string }) => void
}

export class SocketServer {
  private server: net.Server

  constructor(private opts: SocketServerOptions) {
    this.server = net.createServer((conn) => this.handleConnection(conn))
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.opts.socketPath)) fs.unlinkSync(this.opts.socketPath)
    await new Promise<void>((resolve) => this.server.listen(this.opts.socketPath, resolve))
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (fs.existsSync(this.opts.socketPath)) fs.unlinkSync(this.opts.socketPath)
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages) this.handleMessage(conn, msg as any)
    })
  }

  private async handleMessage(conn: net.Socket, msg: any): Promise<void> {
    const requestId: string = msg.requestId ?? randomUUID()

    if (msg.type === 'exec') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }

      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'exec', command: msg.command })

      try {
        const exitCode = await this.opts.sshManager.exec(server, msg.command, (stream, chunk) => {
          this.opts.logStore.appendOutput(runId, chunk)
          const event: DaemonEvent & { requestId: string } = { type: 'stream', requestId, stream, chunk }
          this.send(conn, event)
          this.opts.onBroadcast?.({ ...event, serverId: server.id, agentLabel: msg.agentLabel })
        })
        this.opts.logStore.finish(runId, exitCode)
        const done: DaemonEvent & { requestId: string } = { type: 'done', requestId, exitCode }
        this.send(conn, done)
        this.opts.onBroadcast?.({ ...done, serverId: server.id, agentLabel: msg.agentLabel })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        this.send(conn, { type: 'done', requestId, exitCode: null, error: String(err?.message ?? err) })
      }
      return
    }

    this.send(conn, { type: 'done', requestId, exitCode: null, error: `unsupported request type: ${msg.type}` })
  }

  private send(conn: net.Socket, event: DaemonEvent & { requestId: string }): void {
    conn.write(encodeMessage(event))
  }
}
