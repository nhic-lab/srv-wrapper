import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { Registry } from './registry.js'
import type { LogStore } from './logstore.js'
import type { SshManager, ShellHandle } from './ssh-manager.js'
import type { ServerRecord } from '../shared/types.js'
import { gateSudo, isPasswordPrompt, stripAnsi, SudoError } from './sudo.js'
import { createRedactor, type Redactor } from './redact.js'
import { sanitizeSshError } from './socket-server.js'

export const SHELL_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000
const REDACT_WINDOW_MS = 2000
const PROMPT_TAIL_BYTES = 256
const AGENT_LABEL = 'dashboard'

export interface ShellServerOptions {
  registry: Registry
  logStore: LogStore
  sshManager: SshManager
  /** Same resolver the socket server uses: `<id>:sudo` entry first, then the login password. */
  resolveSudoSecret?: (server: ServerRecord) => string | undefined
  broadcast: (event: object) => void
  idleTimeoutMs?: number
}

/**
 * One browser shell per WebSocket. Client → daemon frames are JSON text:
 *   { t: 'in', d }            keystrokes, written to the PTY as-is (never logged)
 *   { t: 'resize', cols, rows }
 *   { t: 'paste_secret' }     type the stored password into the PTY, daemon-side
 * Daemon → client: binary frames are PTY output; JSON text frames are control:
 *   { t: 'ready', runId } | { t: 'toast', msg } | { t: 'exit' }
 */
export function handleShellConnection(ws: WebSocket, serverId: string, query: URLSearchParams, opts: ShellServerOptions): void {
  const server = opts.registry.get(serverId)
  if (!server) {
    ws.close(4404, 'unknown server')
    return
  }
  const cols = clampInt(query.get('cols'), 80, 2, 500)
  const rows = clampInt(query.get('rows'), 24, 2, 300)
  const root = query.get('root') === '1'

  const runId = randomUUID()
  opts.logStore.start({ id: runId, serverId: server.id, agentLabel: AGENT_LABEL, kind: 'shell', command: null, sudo: root })
  const tag = { serverId: server.id, agentLabel: AGENT_LABEL, kind: 'shell' as const, ...(root ? { sudo: true } : {}) }

  let sudoPassword: string | undefined
  if (root) {
    const gate = gateSudo(server, opts.resolveSudoSecret)
    if (typeof gate !== 'string') {
      opts.logStore.appendOutput(runId, gate.refusal + '\n')
      opts.logStore.finish(runId, null)
      opts.broadcast({ type: 'done', requestId: runId, exitCode: null, error: gate.refusal, ...tag })
      ws.close(4403, gate.refusal)
      return
    }
    sudoPassword = gate
  }

  let handle: ShellHandle | undefined
  let finished = false
  let redactor: Redactor | undefined
  let redactTimer: NodeJS.Timeout | undefined
  let tail = ''
  let idleTimer: NodeJS.Timeout | undefined
  const idleMs = opts.idleTimeoutMs ?? SHELL_IDLE_TIMEOUT_MS

  const finish = () => {
    if (finished) return
    finished = true
    if (idleTimer) clearTimeout(idleTimer)
    if (redactTimer) clearTimeout(redactTimer)
    if (redactor) emit(redactor.flush())
    opts.logStore.finish(runId, null)
    opts.broadcast({ type: 'done', requestId: runId, exitCode: null, ...tag })
  }

  /** The three sinks every output byte goes to. */
  const emit = (buf: Buffer) => {
    if (buf.length === 0) return
    const text = buf.toString()
    tail = stripAnsi(tail + text).slice(-PROMPT_TAIL_BYTES)
    if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true })
    opts.logStore.appendOutput(runId, text)
    opts.broadcast({ type: 'stream', requestId: runId, stream: 'stdout', chunk: text, ...tag })
  }

  const onData = (chunk: Buffer) => {
    if (finished) return
    emit(redactor ? redactor.filter(chunk) : chunk)
  }

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      ws.close(4408, 'closed after 4 h idle')
      handle?.close()
      finish()
    }, idleMs)
  }

  const control = (frame: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  const auditPaste = (accepted: boolean, note: string) => {
    const id = randomUUID()
    opts.logStore.start({ id, serverId: server.id, agentLabel: AGENT_LABEL, kind: 'exec', command: 'paste_secret', sudo: false })
    opts.logStore.appendOutput(id, note + '\n')
    opts.logStore.finish(id, accepted ? 0 : 1)
  }

  const paste = () => {
    let password: string | undefined
    try {
      password = opts.resolveSudoSecret?.(server)
    } catch (err) {
      console.error(`srvd: paste secret lookup failed for ${server.id}:`, err)
    }
    if (password === undefined) {
      control({ t: 'toast', msg: 'No password is stored for this server.' })
      auditPaste(false, 'refused: no password stored')
      return
    }
    if (!isPasswordPrompt(tail)) {
      control({ t: 'toast', msg: 'The shell is not at a password prompt.' })
      auditPaste(false, 'refused: not at a prompt')
      return
    }
    auditPaste(true, 'accepted')
    // Backstop for a prompt that echoes: scrub the exact bytes from every sink for a short window.
    if (redactTimer) clearTimeout(redactTimer)
    if (redactor) emit(redactor.flush())
    redactor = createRedactor(password, REDACT_WINDOW_MS)
    redactTimer = setTimeout(() => {
      if (redactor) emit(redactor.flush())
      redactor = undefined
    }, REDACT_WINDOW_MS)
    handle?.write(password + '\r')
  }

  ws.on('message', (data) => {
    let msg: any
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!handle || finished) return
    if (msg.t === 'in' && typeof msg.d === 'string') {
      armIdle()
      handle.write(msg.d)
    } else if (msg.t === 'resize') {
      handle.resize(clampInt(String(msg.cols), cols, 2, 500), clampInt(String(msg.rows), rows, 2, 300))
    } else if (msg.t === 'paste_secret') {
      armIdle()
      paste()
    }
  })

  ws.on('close', () => {
    handle?.close()
    finish()
  })

  opts.sshManager
    .startShell(server, { cols, rows, sudoPassword }, onData, () => {
      control({ t: 'exit' })
      finish()
      if (ws.readyState === ws.OPEN) ws.close(1000, 'shell ended')
    })
    .then((h) => {
      handle = h
      if (ws.readyState !== ws.OPEN) {
        h.close()
        finish()
        return
      }
      armIdle()
      control({ t: 'ready', runId })
    })
    .catch((err: any) => {
      const safe = err instanceof SudoError ? err.message : sanitizeSshError(err)
      opts.logStore.appendOutput(runId, safe + '\n')
      finish()
      if (ws.readyState === ws.OPEN) ws.close(err instanceof SudoError ? 4403 : 4500, safe)
    })
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}
