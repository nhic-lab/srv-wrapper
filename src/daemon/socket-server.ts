import net from 'node:net'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from './socket-protocol.js'
import type { Registry } from './registry.js'
import type { LogStore } from './logstore.js'
import type { SshManager } from './ssh-manager.js'
import type { DaemonEvent } from '../shared/types.js'

const KNOWN_SSH_ERROR_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENOTFOUND: 'host not found',
  ECONNRESET: 'connection reset',
}

/**
 * SSH/Node connection-level errors routinely embed the literal host/IP and port
 * (e.g. "connect ECONNREFUSED 10.0.0.5:22"). The CLI process must never receive
 * host/port/credentials, so map known error codes to safe, generic messages and
 * fall back to a fully generic message otherwise. The real error is logged
 * server-side only.
 */
function sanitizeSshError(err: any): string {
  const code = err?.code
  if (code && KNOWN_SSH_ERROR_CODES[code]) return `ssh error: ${KNOWN_SSH_ERROR_CODES[code]}`
  console.error('srvd: unclassified SSH error:', err)
  return 'ssh error: connection failed'
}

interface SocketServerOptions {
  socketPath: string
  registry: Registry
  logStore: LogStore
  sshManager: SshManager
  onBroadcast?: (event: DaemonEvent & { requestId: string; serverId?: string; agentLabel?: string; command?: string }) => void
}

export class SocketServer {
  private static readonly SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

  private server: net.Server

  private sessions = new Map<string, {
    serverId: string
    agentLabel: string
    runId: string
    pendingConn: net.Socket | null
    pendingRequestId: string | null
    idleTimer: NodeJS.Timeout | null
    sessionTimeoutTimer: NodeJS.Timeout
  }>()

  constructor(private opts: SocketServerOptions) {
    this.server = net.createServer((conn) => this.handleConnection(conn))
  }

  async start(): Promise<void> {
    if (fs.existsSync(this.opts.socketPath)) fs.unlinkSync(this.opts.socketPath)
    await new Promise<void>((resolve) => this.server.listen(this.opts.socketPath, resolve))
    fs.chmodSync(this.opts.socketPath, 0o600)
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
      for (const msg of messages) {
        this.handleMessage(conn, msg as any).catch((err) => {
          this.send(conn, {
            type: 'done',
            requestId: (msg as any).requestId ?? 'unknown',
            exitCode: null,
            error: `internal error: ${err?.message ?? err}`,
          })
        })
      }
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
          this.opts.onBroadcast?.({ ...event, serverId: server.id, agentLabel: msg.agentLabel, command: msg.command })
        })
        this.opts.logStore.finish(runId, exitCode)
        const done: DaemonEvent & { requestId: string } = { type: 'done', requestId, exitCode }
        this.send(conn, done)
        this.opts.onBroadcast?.({ ...done, serverId: server.id, agentLabel: msg.agentLabel })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        this.send(conn, { type: 'done', requestId, exitCode: null, error: sanitizeSshError(err) })
      }
      return
    }

    if (msg.type === 'session_start') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }
      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'session', command: null })

      try {
        const sessionId = await this.opts.sshManager.startSession(server, (chunk) => {
          this.opts.logStore.appendOutput(runId, chunk)
          const session = this.sessions.get(sessionId)
          if (session?.pendingConn && session.pendingRequestId) {
            this.send(session.pendingConn, { type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk })
            this.opts.onBroadcast?.({ type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk, serverId: server.id, agentLabel: msg.agentLabel })
            if (session.idleTimer) clearTimeout(session.idleTimer)
            session.idleTimer = setTimeout(() => this.finalizePendingSend(sessionId), 300)
          }
        })

        this.sessions.set(sessionId, {
          serverId: server.id, agentLabel: msg.agentLabel, runId,
          pendingConn: null, pendingRequestId: null, idleTimer: null,
          sessionTimeoutTimer: this.scheduleSessionTimeout(sessionId),
        })
        this.send(conn, { type: 'session_started', requestId, sessionId })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        this.send(conn, { type: 'done', requestId, exitCode: null, error: sanitizeSshError(err) })
      }
      return
    }

    if (msg.type === 'session_send') {
      const session = this.sessions.get(msg.sessionId)
      if (!session) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown session: ${msg.sessionId}` })
        return
      }
      session.pendingConn = conn
      session.pendingRequestId = requestId
      clearTimeout(session.sessionTimeoutTimer)
      session.sessionTimeoutTimer = this.scheduleSessionTimeout(msg.sessionId)
      this.opts.sshManager.sendToSession(msg.sessionId, msg.command)
      if (session.idleTimer) clearTimeout(session.idleTimer)
      session.idleTimer = setTimeout(() => this.finalizePendingSend(msg.sessionId), 300)
      return
    }

    if (msg.type === 'session_stop') {
      const session = this.sessions.get(msg.sessionId)
      if (!session) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown session: ${msg.sessionId}` })
        return
      }
      clearTimeout(session.sessionTimeoutTimer)
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.opts.sshManager.stopSession(msg.sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(msg.sessionId)
      this.send(conn, { type: 'done', requestId, exitCode: null })
      return
    }

    this.send(conn, { type: 'done', requestId, exitCode: null, error: `unsupported request type: ${msg.type}` })
  }

  private scheduleSessionTimeout(sessionId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.opts.sshManager.stopSession(sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(sessionId)
    }, SocketServer.SESSION_IDLE_TIMEOUT_MS)
  }

  private finalizePendingSend(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pendingConn || !session.pendingRequestId) return
    this.send(session.pendingConn, { type: 'done', requestId: session.pendingRequestId, exitCode: null })
    session.pendingConn = null
    session.pendingRequestId = null
    session.idleTimer = null
  }

  private send(conn: net.Socket, event: DaemonEvent & { requestId: string }): void {
    conn.write(encodeMessage(event))
  }
}
