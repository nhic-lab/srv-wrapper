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

  function retryableError(message: string): Error {
    const err: any = new Error(message)
    err.retryable = true
    return err
  }

  it('retries up to the given count on a retryable rejection, then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(retryableError('transport')).mockResolvedValueOnce('ok')
    await expect(withRetry(fn, 1)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws the last error once retries are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('still broken'))
    await expect(withRetry(fn, 2)).rejects.toThrow('still broken')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('never retries a resolved value, even a non-zero exit code', async () => {
    const fn = vi.fn().mockResolvedValue(1)
    await expect(withRetry(fn, 5)).resolves.toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('never retries a rejection that is not marked retryable (e.g. a timeout, or a command that may have already run)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('command timed out after 5s'))
    await expect(withRetry(fn, 3)).rejects.toThrow('command timed out after 5s')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('treats a non-finite or negative retries value as 0 instead of retrying forever', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('transport'))
    await expect(withRetry(fn, NaN)).rejects.toThrow('transport')
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

  it('falls back to a single worker instead of running zero workers when parallel is not a finite number', async () => {
    await startFakeDaemon((msg, write) => {
      if (msg.type !== 'exec') return
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })

    const results = await execMany({
      socketPath, serverIds: ['srv-a1', 'srv-b2'], agentLabel: 'claude-a', command: 'echo hi',
      parallel: NaN, retries: 0, onStream: () => {},
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.exitCode === 0)).toBe(true)
  })

  it('retries a server that fails with a connection error, and succeeds on the retry', async () => {
    let attempts = 0
    await startFakeDaemon((msg, write) => {
      if (msg.type !== 'exec') return
      attempts++
      if (attempts === 1) {
        write({ type: 'done', requestId: msg.requestId, exitCode: null, error: 'ssh error: connection refused', retryable: true })
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

describe('--sudo flag plumbing', () => {
  it('execCommand sends sudo: true only when asked', async () => {
    const seen: any[] = []
    await startFakeDaemon((msg, write) => {
      seen.push(msg)
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })
    await execCommand({ socketPath, serverId: 'srv-a1', agentLabel: 'a', command: 'id', sudo: true, onStream: () => {} })
    await execCommand({ socketPath, serverId: 'srv-a1', agentLabel: 'a', command: 'id', onStream: () => {} })
    expect(seen[0].sudo).toBe(true)
    expect('sudo' in seen[1]).toBe(false)
  })

  it('execMany forwards sudo to every per-server exec request', async () => {
    const seen: any[] = []
    await startFakeDaemon((msg, write) => {
      seen.push(msg)
      write({ type: 'done', requestId: msg.requestId, exitCode: 0 })
    })
    await execMany({ socketPath, serverIds: ['a', 'b'], agentLabel: 'x', command: 'id', parallel: 2, retries: 0, sudo: true, onStream: () => {} })
    expect(seen.map((m) => m.sudo)).toEqual([true, true])
  })

  it('sessionStart sends sudo: true only when asked', async () => {
    const seen: any[] = []
    await startFakeDaemon((msg, write) => {
      seen.push(msg)
      write({ type: 'session_started', requestId: msg.requestId, sessionId: 's' })
    })
    await sessionStart({ socketPath, serverId: 'srv-a1', agentLabel: 'a', sudo: true })
    await sessionStart({ socketPath, serverId: 'srv-a1', agentLabel: 'a' })
    expect(seen[0].sudo).toBe(true)
    expect('sudo' in seen[1]).toBe(false)
  })
})
