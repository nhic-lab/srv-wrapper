import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { encodeMessage, decodeMessages } from '../daemon/socket-protocol.js'

export interface ExecCommandOptions {
  socketPath: string
  serverId: string
  agentLabel: string
  command: string
  onStream: (stream: 'stdout' | 'stderr', chunk: string) => void
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
          if (msg.error) reject(new Error(msg.error))
          else resolve(msg.exitCode)
        }
      }
    })

    conn.on('error', reject)
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
