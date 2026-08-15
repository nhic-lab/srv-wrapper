import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execCommand, sessionStart, sessionSend, sessionStop, listServers } from '../../src/cli/client.js'
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
