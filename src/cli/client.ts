import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from '../daemon/socket-protocol.js'
import type { ServerStatus } from '../shared/types.js'

export interface ExecCommandOptions {
  socketPath: string
  serverId: string
  agentLabel: string
  command: string
  /** Kill the command and reject if it runs longer than this. Absent/0 means no timeout. */
  timeoutMs?: number
  onStream: (stream: 'stdout' | 'stderr', chunk: string) => void
}

/** Retries `fn` immediately (no backoff) up to `retries` additional times, only while it rejects
 *  with an error marked `.retryable === true` (set only for a connection/transport failure where
 *  the command never ran) — a resolved value (even a non-zero exit code), a timeout, or any other
 *  rejection is never retried, since the command may already have run. A non-finite or negative
 *  `retries` (e.g. from an unparsable `--retry` flag) is treated as 0, never as "unlimited". */
export async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  const limit = Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 0
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err: any) {
      if (attempt++ >= limit || err?.retryable !== true) throw err
    }
  }
}

export function execCommand(opts: ExecCommandOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''

    conn.on('connect', () => {
      conn.write(
        encodeMessage({
          type: 'exec',
          requestId,
          serverId: opts.serverId,
          agentLabel: opts.agentLabel,
          command: opts.command,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        })
      )
    })

    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'stream') {
          opts.onStream(msg.stream, msg.chunk)
        } else if (msg.type === 'done') {
          conn.end()
          if (msg.error) {
            const err: any = new Error(msg.error)
            err.retryable = msg.retryable === true
            reject(err)
          } else {
            resolve(msg.exitCode)
          }
        }
      }
    })

    conn.on('error', (err: any) => {
      // Failing to even reach the daemon's socket is itself a transport
      // failure — the exec request was never sent, so it's safe to retry.
      err.retryable = true
      reject(err)
    })
  })
}

export function sessionStart(opts: { socketPath: string; serverId: string; agentLabel: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_start', requestId, serverId: opts.serverId, agentLabel: opts.agentLabel }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'session_started') { conn.end(); resolve(msg.sessionId) }
        else if (msg.type === 'done' && msg.error) { conn.end(); reject(new Error(msg.error)) }
      }
    })
    conn.on('error', reject)
  })
}

export function sessionSend(opts: { socketPath: string; sessionId: string; command: string; onStream: (stream: 'stdout' | 'stderr', chunk: string) => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_send', requestId, sessionId: opts.sessionId, command: opts.command }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'stream') opts.onStream(msg.stream, msg.chunk)
        else if (msg.type === 'done') { conn.end(); msg.error ? reject(new Error(msg.error)) : resolve() }
      }
    })
    conn.on('error', reject)
  })
}

export function listServers(opts: { socketPath: string }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'list', requestId }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'list_result') { conn.end(); resolve(msg.serverIds) }
        else if (msg.type === 'done' && msg.error) { conn.end(); reject(new Error(msg.error)) }
      }
    })
    conn.on('error', reject)
  })
}

export interface ExecManyResult {
  serverId: string
  exitCode: number | null
  /** Set when every attempt failed before the command ever ran (connection/transport failure). */
  error?: string
}

export interface ExecManyOptions {
  socketPath: string
  serverIds: string[]
  agentLabel: string
  command: string
  /** Max number of servers to run concurrently. */
  parallel: number
  timeoutMs?: number
  /** Retries per server, on connection/transport failure only. */
  retries: number
  onStream: (serverId: string, stream: 'stdout' | 'stderr', chunk: string) => void
}

/** Runs `command` on every server in `opts.serverIds` concurrently (bounded by `opts.parallel`),
 *  each with its own independent retry budget — one server's failure never blocks the others. */
export async function execMany(opts: ExecManyOptions): Promise<ExecManyResult[]> {
  const results: ExecManyResult[] = new Array(opts.serverIds.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < opts.serverIds.length) {
      const i = next++
      const serverId = opts.serverIds[i]
      try {
        const exitCode = await withRetry(
          () =>
            execCommand({
              socketPath: opts.socketPath,
              serverId,
              agentLabel: opts.agentLabel,
              command: opts.command,
              timeoutMs: opts.timeoutMs,
              onStream: (stream, chunk) => opts.onStream(serverId, stream, chunk),
            }),
          opts.retries
        )
        results[i] = { serverId, exitCode }
      } catch (err: any) {
        results[i] = { serverId, exitCode: null, error: err.message }
      }
    }
  }

  // A non-finite parallel (e.g. from an unparsable --parallel flag) falls back to 1 rather than
  // silently producing a 0-length worker pool that would leave `results` entirely unpopulated.
  const requested = Number.isFinite(opts.parallel) ? opts.parallel : 1
  const workerCount = Math.max(1, Math.min(requested, opts.serverIds.length))
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

export function listStatus(opts: { socketPath: string }): Promise<ServerStatus[]> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'list_status', requestId }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'list_status_result') { conn.end(); resolve(msg.results) }
        else if (msg.type === 'done' && msg.error) { conn.end(); reject(new Error(msg.error)) }
      }
    })
    conn.on('error', reject)
  })
}

export function sessionStop(opts: { socketPath: string; sessionId: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID()
    const conn = net.createConnection(opts.socketPath)
    let buffer = ''
    conn.on('connect', () => {
      conn.write(encodeMessage({ type: 'session_stop', requestId, sessionId: opts.sessionId }))
    })
    conn.on('data', (data) => {
      buffer += data.toString()
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest
      for (const msg of messages as any[]) {
        if (msg.type === 'done') { conn.end(); msg.error ? reject(new Error(msg.error)) : resolve() }
      }
    })
    conn.on('error', reject)
  })
}
