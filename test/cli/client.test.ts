import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execCommand, execMany, withRetry, sessionStart, sessionSend, sessionStop, listServers, listStatus } from '../../src/cli/client.js'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let socketPath: string
let server: net.Server

beforeEach(() => {
  socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-cli-test-')), 'srv.sock')
})

afterEach(() => {
  server?.close()
  fs.rmSync(path.dirname(socketPath), { recursive: true, force: true })
})

function startFakeDaemon(handler: (msg: any, write: (obj: object) => void) => void) {
  server = net.createServer((conn) => {
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines.filter(Boolean)) {
        handler(JSON.parse(line), (obj) => conn.write(JSON.stringify(obj) + '\n'))
      }
    })
  })
  return new Promise<void>((resolve) => server.listen(socketPath, resolve))
}

describe('execCommand', () => {
  it('sends an exec request and resolves with the exit code after streaming output', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('exec')
      expect(msg.serverId).toBe('srv-a1')
      expect(msg.agentLabel).toBe('claude-a')
      write({ type: 'stream', requestId: msg.requestId, stream: 'stdout', chunk: 'hi\n' })
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })

    const chunks: Array<[string, string]> = []
    const exitCode = await execCommand({
      socketPath, serverId: 'srv-a1', agentLabel: 'claude-a', command: 'echo hi',
      onStream: (s, c) => chunks.push([s, c]),
    })

    expect(chunks).toEqual([['stdout', 'hi\n']])
    expect(exitCode).toBe(0)
  })

  it('rejects when the daemon reports an error in the done event', async () => {
    await startFakeDaemon((msg, write) => {
      write({ type: 'done', requestId: msg.requestId, exitCode: null, error: 'unknown server: nope' })
    })

    await expect(
      execCommand({ socketPath, serverId: 'nope', agentLabel: 'a', command: 'x', onStream: () => {} })
    ).rejects.toThrow(/unknown server/)
  })
})

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withRetry(fn, 3)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries up to the given count on rejection, then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce('ok')
    await expect(withRetry(fn, 1)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws the last error once retries are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still broken'))
    await expect(withRetry(fn, 2)).rejects.toThrow('still broken')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('never retries a resolved value, even a non-zero exit code', async () => {
    const fn = vi.fn().mockResolvedValue(1)
    await expect(withRetry(fn, 5)).resolves.toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('execMany', () => {
  it('runs the command on every server id and tags each stream callback with its serverId', async () => {
    await startFakeDaemon((msg, write) => {
      if (msg.type !== 'exec') return
      write({ type: 'stream', requestId: msg.requestId, stream: 'stdout', chunk: `hi from ${msg.serverId}\n` })
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })

    const seen: Array<[string, string]> = []
    const results = await execMany({
      socketPath, serverIds: ['srv-a1', 'srv-b2', 'srv-c3'], agentLabel: 'claude-a', command: 'echo hi',
      parallel: 2, retries: 0,
      onStream: (serverId, _stream, chunk) => seen.push([serverId, chunk]),
    })

    expect(results.map((r) => r.serverId).sort()).toEqual(['srv-a1', 'srv-b2', 'srv-c3'])
    expect(results.every((r) => r.exitCode === 0)).toBe(true)
    expect(seen).toContainEqual(['srv-a1', 'hi from srv-a1\n'])
    expect(seen).toContainEqual(['srv-b2', 'hi from srv-b2\n'])
    expect(seen).toContainEqual(['srv-c3', 'hi from srv-c3\n'])
  })

  it('records a per-server error without aborting the other servers', async () => {
    await startFakeDaemon((msg, write) => {
      if (msg.type !== 'exec') return
      if (msg.serverId === 'srv-bad') {
        write({ type: 'done', requestId: msg.requestId, exitCode: null, error: 'ssh error: connection refused' })
      } else {
        write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
      }
    })

    const results = await execMany({
      socketPath, serverIds: ['srv-bad', 'srv-good'], agentLabel: 'claude-a', command: 'echo hi',
      parallel: 2, retries: 0, onStream: () => {},
    })

    const byId = Object.fromEntries(results.map((r) => [r.serverId, r]))
    expect(byId['srv-bad'].error).toMatch(/connection refused/)
    expect(byId['srv-good'].exitCode).toBe(0)
  })

  it('retries a server that fails with a connection error, and succeeds on the retry', async () => {
    let attempts = 0
    await startFakeDaemon((msg, write) => {
      if (msg.type !== 'exec') return
      attempts++
      if (attempts === 1) {
        write({ type: 'done', requestId: msg.requestId, exitCode: null, error: 'ssh error: connection refused' })
      } else {
        write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
      }
    })

    const results = await execMany({
      socketPath, serverIds: ['srv-a1'], agentLabel: 'claude-a', command: 'echo hi',
      parallel: 1, retries: 1, onStream: () => {},
    })

    expect(attempts).toBe(2)
    expect(results[0].exitCode).toBe(0)
    expect(results[0].error).toBeUndefined()
  })
})

describe('listStatus', () => {
  it('resolves with the results from list_status_result', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('list_status')
      write({
        type: 'list_status_result', requestId: msg.requestId,
        results: [{ id: 'srv-a1', reachable: true }, { id: 'srv-b2', reachable: false, error: 'ssh error: connection refused' }],
      })
    })
    const results = await listStatus({ socketPath })
    expect(results).toEqual([
      { id: 'srv-a1', reachable: true },
      { id: 'srv-b2', reachable: false, error: 'ssh error: connection refused' },
    ])
  })
})

describe('listServers', () => {
  it('resolves with the serverIds from list_result', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('list')
      write({ type: 'list_result', requestId: msg.requestId, serverIds: ['srv-a1', 'srv-b2'] })
    })
    const serverIds = await listServers({ socketPath })
    expect(serverIds).toEqual(['srv-a1', 'srv-b2'])
  })
})

describe('session client functions', () => {
  it('sessionStart resolves with the sessionId from session_started', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('session_start')
      write({ type: 'session_started', requestId: msg.requestId, sessionId: 'sess-123' })
    })
    const sessionId = await sessionStart({ socketPath, serverId: 'srv-a1', agentLabel: 'agent-x' })
    expect(sessionId).toBe('sess-123')
  })

  it('sessionSend streams output then resolves on done', async () => {
    await startFakeDaemon((msg, write) => {
      if (msg.type === 'session_send') {
        write({ type: 'stream', requestId: msg.requestId, stream: 'stdout', chunk: 'out\n' })
        write({ type: 'done', requestId: msg.requestId, exitCode: null })
      }
    })
    const chunks: string[] = []
    await sessionSend({ socketPath, sessionId: 'sess-123', command: 'ls\n', onStream: (_s, c) => chunks.push(c) })
    expect(chunks).toEqual(['out\n'])
  })

  it('sessionStop resolves once the daemon confirms with done', async () => {
    await startFakeDaemon((msg, write) => {
      expect(msg.type).toBe('session_stop')
      write({ type: 'done', requestId: msg.requestId, exitCode: null })
    })
    await expect(sessionStop({ socketPath, sessionId: 'sess-123' })).resolves.toBeUndefined()
  })
})
