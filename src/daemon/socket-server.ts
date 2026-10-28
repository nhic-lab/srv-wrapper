import net from 'node:net'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from './socket-protocol.js'
import type { Registry } from './registry.js'
import type { LogStore } from './logstore.js'
import { CommandTimeoutError, checkReachable, type SshManager } from './ssh-manager.js'
import type { DaemonEvent, ServerStatus, ServerRecord } from '../shared/types.js'
import { SudoError } from './sudo.js'

const KNOWN_SSH_ERROR_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENOTFOUND: 'host not found (dns)',
  ECONNRESET: 'connection reset',
}

/**
 * SSH/Node connection-level errors routinely embed the literal host/IP and port
 * (e.g. "connect ECONNREFUSED 10.0.0.5:22"). The CLI process must never receive
 * host/port/credentials, so map known error codes to safe, generic messages and
 * fall back to a fully generic message otherwise. The real error is logged
 * server-side only.
 */
export function sanitizeSshError(err: any): string {
  const code = err?.code
  if (code && KNOWN_SSH_ERROR_CODES[code]) return `ssh error: ${KNOWN_SSH_ERROR_CODES[code]}`
  if (err?.level === 'client-authentication') return 'ssh error: authentication failed'
  if (typeof err?.message === 'string' && /host verification failed/i.test(err.message)) {
    return 'ssh error: host key verification failed (possible server identity change)'
  }
  console.error('srvd: unclassified SSH error:', err)
  return 'ssh error: connection failed'
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once, preserving result order. */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, worker))
  return results
}

interface SocketServerOptions {
  socketPath: string
  registry: Registry
  logStore: LogStore
  sshManager: SshManager
  /**
   * Resolves the sudo password for a server, or undefined when none is
   * available. Wired by the daemon to: the `<id>:sudo` Keychain entry, else
   * the login password for password-auth servers, else nothing.
   */
  resolveSudoSecret?: (server: ServerRecord) => string | undefined
  onBroadcast?: (event: DaemonEvent & { requestId: string; serverId?: string; agentLabel?: string; command?: string; sudo?: boolean }) => void
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

  private static readonly STATUS_CHECK_CONCURRENCY = 16

  private async handleMessage(conn: net.Socket, msg: any): Promise<void> {
    const requestId: string = msg.requestId ?? randomUUID()

    if (msg.type === 'list') {
      const serverIds = this.opts.registry.list().map((s) => s.id)
      this.send(conn, { type: 'list_result', requestId, serverIds })
      return
    }

    if (msg.type === 'list_status') {
      const servers = this.opts.registry.list()
      // Group by host:port, ordered by createdAt (not registry.list()'s alphabetical-by-id
      // order) so "duplicateOf" always points at the server that was actually registered
      // first, regardless of what id either one happens to have.
      const idsByHostPort = new Map<string, string[]>()
      for (const s of [...servers].sort((a, b) => a.createdAt - b.createdAt)) {
        const key = `${s.host}:${s.port}`
        const ids = idsByHostPort.get(key) ?? []
        ids.push(s.id)
        idsByHostPort.set(key, ids)
      }

      const results: ServerStatus[] = await mapWithConcurrency(
        servers,
        SocketServer.STATUS_CHECK_CONCURRENCY,
        async (server) => {
          const group = idsByHostPort.get(`${server.host}:${server.port}`)!
          const duplicateOf = group.length > 1 && group[0] !== server.id ? group[0] : undefined
          try {
            await checkReachable(server.host, server.port)
            return { id: server.id, reachable: true, duplicateOf }
          } catch (err) {
            return { id: server.id, reachable: false, error: sanitizeSshError(err), duplicateOf }
          }
        }
      )
      this.send(conn, { type: 'list_status_result', requestId, results })
      return
    }

    if (msg.type === 'exec') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }

      const sudo = msg.sudo === true
      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'exec', command: msg.command, sudo })
      const tag = sudo ? { sudo: true } : {}

      const resolved = sudo ? this.resolveSudo(server) : undefined
      if (resolved !== undefined && typeof resolved !== 'string') {
        this.refuse(conn, requestId, runId, server, msg.agentLabel, resolved.refusal)
        return
      }
      const sudoOpts = typeof resolved === 'string' ? { sudoPassword: resolved } : undefined

      try {
        const exitCode = await this.opts.sshManager.exec(
          server,
          msg.command,
          (stream, chunk) => {
            this.opts.logStore.appendOutput(runId, chunk)
            const event: DaemonEvent & { requestId: string } = { type: 'stream', requestId, stream, chunk }
            this.send(conn, event)
            this.opts.onBroadcast?.({ ...event, serverId: server.id, agentLabel: msg.agentLabel, command: msg.command, ...tag })
          },
          msg.timeoutMs || undefined,
          sudoOpts
        )
        this.opts.logStore.finish(runId, exitCode)
        const done: DaemonEvent & { requestId: string } = { type: 'done', requestId, exitCode }
        this.send(conn, done)
        this.opts.onBroadcast?.({ ...done, serverId: server.id, agentLabel: msg.agentLabel, ...tag })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        const safe = err instanceof CommandTimeoutError || err instanceof SudoError ? err.message : sanitizeSshError(err)
        // A timeout or a mid-stream channel error means the command may already have run
        // (fully or partially) — only a pre-exec connection failure is ever safe to retry.
        const retryable = !(err instanceof CommandTimeoutError) && err?.retryable === true
        this.send(conn, { type: 'done', requestId, exitCode: null, error: safe, retryable })
        // The dashboard needs this too — without it a run that failed to
        // connect is left streaming forever in the live view.
        this.opts.onBroadcast?.({ type: 'done', requestId, exitCode: null, error: safe, serverId: server.id, agentLabel: msg.agentLabel, ...tag })
      }
      return
    }

    if (msg.type === 'session_start') {
      const server = this.opts.registry.get(msg.serverId)
      if (!server) {
        this.send(conn, { type: 'done', requestId, exitCode: null, error: `unknown server: ${msg.serverId}` })
        return
      }
      const sudo = msg.sudo === true
      const runId = randomUUID()
      this.opts.logStore.start({ id: runId, serverId: server.id, agentLabel: msg.agentLabel, kind: 'session', command: null, sudo })
      const tag = sudo ? { sudo: true } : {}

      const resolved = sudo ? this.resolveSudo(server) : undefined
      if (resolved !== undefined && typeof resolved !== 'string') {
        this.refuse(conn, requestId, runId, server, msg.agentLabel, resolved.refusal)
        return
      }
      const sudoOpts = typeof resolved === 'string' ? { sudoPassword: resolved } : undefined

      try {
        const sessionId = await this.opts.sshManager.startSession(server, (chunk) => {
          this.opts.logStore.appendOutput(runId, chunk)
          const session = this.sessions.get(sessionId)
          if (session?.pendingConn && session.pendingRequestId) {
            this.send(session.pendingConn, { type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk })
            this.opts.onBroadcast?.({ type: 'stream', requestId: session.pendingRequestId, stream: 'stdout', chunk, serverId: server.id, agentLabel: msg.agentLabel, ...tag })
            if (session.idleTimer) clearTimeout(session.idleTimer)
            session.idleTimer = setTimeout(() => this.finalizePendingSend(sessionId), 300)
          }
        }, sudoOpts)

        this.sessions.set(sessionId, {
          serverId: server.id, agentLabel: msg.agentLabel, runId,
          pendingConn: null, pendingRequestId: null, idleTimer: null,
          sessionTimeoutTimer: this.scheduleSessionTimeout(sessionId),
        })
        this.send(conn, { type: 'session_started', requestId, sessionId })
      } catch (err: any) {
        this.opts.logStore.finish(runId, null)
        this.send(conn, { type: 'done', requestId, exitCode: null, error: err instanceof SudoError ? err.message : sanitizeSshError(err) })
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
      this.finalizePendingSend(msg.sessionId)
      this.opts.sshManager.stopSession(msg.sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(msg.sessionId)
      this.send(conn, { type: 'done', requestId, exitCode: null })
      return
    }

    this.send(conn, { type: 'done', requestId, exitCode: null, error: `unsupported request type: ${msg.type}` })
  }

  /**
   * The sudo gate. Both refusals happen before any SSH connection is made, and
   * the caller records them in the audit log so the history shows who tried.
   */
  private resolveSudo(server: ServerRecord): string | { refusal: string } {
    if (!server.sudoAllowed) return { refusal: `sudo is not enabled for ${server.id}` }
    const password = this.opts.resolveSudoSecret?.(server)
    if (password === undefined) return { refusal: `sudo error: no sudo password stored for ${server.id}` }
    return password
  }

  private refuse(conn: net.Socket, requestId: string, runId: string, server: ServerRecord, agentLabel: string, refusal: string): void {
    this.opts.logStore.appendOutput(runId, refusal + '\n')
    this.opts.logStore.finish(runId, null)
    this.send(conn, { type: 'done', requestId, exitCode: null, error: refusal })
    this.opts.onBroadcast?.({ type: 'done', requestId, exitCode: null, error: refusal, serverId: server.id, agentLabel, sudo: true })
  }

  private scheduleSessionTimeout(sessionId: string): NodeJS.Timeout {
    return setTimeout(() => {
      const session = this.sessions.get(sessionId)
      if (!session) return
      if (session.idleTimer) clearTimeout(session.idleTimer)
      this.finalizePendingSend(sessionId)
      this.opts.sshManager.stopSession(sessionId)
      this.opts.logStore.finish(session.runId, null)
      this.sessions.delete(sessionId)
    }, SocketServer.SESSION_IDLE_TIMEOUT_MS)
  }

  private finalizePendingSend(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session?.pendingConn || !session.pendingRequestId) return
    this.send(session.pendingConn, { type: 'done', requestId: session.pendingRequestId, exitCode: null })
    // Mirrored to the dashboard so the send's live row settles instead of
    // streaming indefinitely.
    this.opts.onBroadcast?.({
      type: 'done', requestId: session.pendingRequestId, exitCode: null,
      serverId: session.serverId, agentLabel: session.agentLabel,
    })
    session.pendingConn = null
    session.pendingRequestId = null
    session.idleTimer = null
  }

  private send(conn: net.Socket, event: DaemonEvent & { requestId: string }): void {
    conn.write(encodeMessage(event))
  }
}
