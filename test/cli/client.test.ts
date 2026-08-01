import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execCommand } from '../../src/cli/client.js'
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
