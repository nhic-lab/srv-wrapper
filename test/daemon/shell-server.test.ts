import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { createDashboardApp } from '../../src/daemon/dashboard-server.js'
import { Registry } from '../../src/daemon/registry.js'
import { Keychain } from '../../src/daemon/keychain.js'
import { LogStore } from '../../src/daemon/logstore.js'
import { SshManager } from '../../src/daemon/ssh-manager.js'
import type { ServerRecord } from '../../src/shared/types.js'

const ORIGIN = 'http://127.0.0.1:4280'

let dir: string
let registry: Registry
let logStore: LogStore
let keychain: Keychain
let httpServer: http.Server
let liveWs: WebSocket
let port: number
let broadcasts: any[]

/** A fake PTY channel. `script` runs after each write so tests can play the remote's side. */
function makeChannel(script?: (written: string, writes: string[], emit: (s: string) => void) => void) {
  const channel = new EventEmitter() as any
  const writes: string[] = []
  channel.setWindow = vi.fn()
  channel.end = vi.fn(() => queueMicrotask(() => channel.emit('close')))
  channel.write = vi.fn((s: string | Buffer) => {
    writes.push(s.toString())
    if (script) queueMicrotask(() => script(s.toString(), writes, (out) => channel.emit('data', Buffer.from(out))))
  })
  return { channel, writes }
}

interface SetupOpts {
  script?: (written: string, writes: string[], emit: (s: string) => void) => void
  resolveSudoSecret?: (s: ServerRecord) => string | undefined
  shellIdleTimeoutMs?: number
}

async function setup(o: SetupOpts = {}) {
  const { channel, writes } = makeChannel(o.script)
  const shellCalls: any[] = []
  let connectCalls = 0
  const sshManager = new SshManager(
    () => 'login',
    async () => {
      connectCalls += 1
      return { end: vi.fn(), shell: (opts: any, cb: any) => { shellCalls.push(opts); cb(null, channel) } }
    }
  )
  broadcasts = []
  const { app } = createDashboardApp({
    registry, keychain, logStore, sshManager,
    resolveSudoSecret: o.resolveSudoSecret,
    shellIdleTimeoutMs: o.shellIdleTimeoutMs,
  })
  httpServer = http.createServer(app)
  ;(app as any).attachWebSocket(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const addr = httpServer.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // A second dashboard tab watching Live: everything the shell broadcasts lands here.
  liveWs = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { Origin: ORIGIN } })
  liveWs.on('message', (d) => broadcasts.push(JSON.parse(d.toString())))
  await new Promise<void>((resolve) => liveWs.on('open', () => resolve()))
  return { channel, writes, shellCalls, connectCalls: () => connectCalls }
}

/** Opens a shell socket and collects frames until `until` matches one, or the socket closes. */
function openShell(query: string, headers: Record<string, string> = { Origin: ORIGIN }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/shell/${query}`, { headers })
  const frames: any[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  ws.on('message', (data, isBinary) => frames.push(isBinary ? { bin: Buffer.from(data as Buffer) } : JSON.parse(data.toString())))
  const opened = new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); ws.on('unexpected-response', () => reject(new Error('rejected'))) })
  const waitFor = (pred: (f: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const f = frames.find(pred)
      if (f) return resolve(f)
      if (Date.now() - t0 > ms) return reject(new Error('frame not seen: ' + JSON.stringify(frames)))
      setTimeout(tick, 5)
    }
    tick()
  })
  const send = (obj: object) => ws.send(JSON.stringify(obj))
  return { ws, frames, opened, closed, waitFor, send }
}

const binText = (frames: any[]) => Buffer.concat(frames.filter((f) => f.bin).map((f) => f.bin)).toString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-shell-test-'))
  registry = new Registry(path.join(dir, 'registry.db'))
  logStore = new LogStore(path.join(dir, 'log.db'))
  keychain = new Keychain('/usr/local/bin/srvd', () => ({ stdout: '', status: 1 }))
  registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password' })
})

afterEach(async () => {
  liveWs.close()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  registry.close()
  logStore.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('/api/shell/:id', () => {
  it('rejects a bad Origin, an unknown id (4404) and a malformed path', async () => {
    await setup()
    await expect(openShell('srv-a1?cols=80&rows=24', { Origin: 'http://evil.example.com' }).opened).rejects.toBeDefined()
    const unknown = openShell('nope?cols=80&rows=24')
    await unknown.opened
    expect(await unknown.closed).toEqual({ code: 4404, reason: 'unknown server' })
    await expect(openShell('srv-a1/extra?cols=80&rows=24').opened).rejects.toBeDefined()
  })

  it('opens a shell with the query cols/rows, sends ready with a run id, relays output as binary frames, logs it and broadcasts it as agent "dashboard"', async () => {
    const { channel, shellCalls } = await setup()
    const sh = openShell('srv-a1?cols=100&rows=30')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    expect(shellCalls[0]).toEqual({ term: 'xterm-256color', cols: 100, rows: 30 })
    channel.emit('data', Buffer.from('hello \u2713\n'))
    await sh.waitFor((f) => f.bin)
    expect(binText(sh.frames)).toBe('hello \u2713\n')
    const run = logStore.get(ready.runId)!
    expect(run).toMatchObject({ kind: 'shell', agentLabel: 'dashboard', command: null, sudo: false, output: 'hello \u2713\n' })
    expect(broadcasts.find((b) => b.type === 'stream')).toMatchObject({ requestId: ready.runId, stream: 'stdout', chunk: 'hello \u2713\n', serverId: 'srv-a1', agentLabel: 'dashboard', kind: 'shell' })
    sh.ws.close()
    await sh.closed
  })

  it('never logs or broadcasts keystrokes: an "in" frame reaches the PTY only', async () => {
    const { channel, writes } = await setup()
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    sh.send({ t: 'in', d: 'secret-keys\r' })
    await sleep(30)
    expect(writes).toEqual(['secret-keys\r'])
    expect(logStore.get(ready.runId)!.output).toBe('')
    expect(JSON.stringify(broadcasts)).not.toContain('secret-keys')
    channel.emit('data', Buffer.from('x'))
    sh.ws.close()
    await sh.closed
  })

  it('resize frames call setWindow', async () => {
    const { channel } = await setup()
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    sh.send({ t: 'resize', cols: 132, rows: 43 })
    await sleep(30)
    expect(channel.setWindow).toHaveBeenCalledWith(43, 132, 0, 0)
    sh.ws.close()
    await sh.closed
  })

  it('closing the socket closes the shell and finishes the run; the shell ending sends exit and closes the socket', async () => {
    const a = await setup()
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    sh.ws.close()
    await sh.closed
    await sleep(30)
    expect(a.channel.end).toHaveBeenCalled()
    expect(logStore.get(ready.runId)!.endedAt).not.toBeNull()
    expect(broadcasts.find((b) => b.type === 'done')).toMatchObject({ requestId: ready.runId, kind: 'shell' })
    liveWs.close()
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))

    const b = await setup()
    const sh2 = openShell('srv-a1?cols=80&rows=24')
    await sh2.opened
    const ready2 = await sh2.waitFor((f) => f.t === 'ready')
    b.channel.emit('close')
    await sh2.waitFor((f) => f.t === 'exit')
    expect((await sh2.closed).code).toBe(1000)
    expect(logStore.get(ready2.runId)!.endedAt).not.toBeNull()
  })

  it('root=1 on a server with sudo off closes 4403 with the exact refusal and logs a refused shell run', async () => {
    const a = await setup({ resolveSudoSecret: () => 'rootpw' })
    const sh = openShell('srv-a1?cols=80&rows=24&root=1')
    await sh.opened
    expect(await sh.closed).toEqual({ code: 4403, reason: 'sudo is not enabled for srv-a1' })
    expect(a.connectCalls()).toBe(0)
    const run = logStore.list()[0]
    expect(run).toMatchObject({ kind: 'shell', sudo: true, agentLabel: 'dashboard' })
    expect(run.endedAt).not.toBeNull()
    expect(logStore.get(run.id)!.output).toContain('sudo is not enabled for srv-a1')
  })

  it('root=1 primes sudo through the existing primer and marks the run sudo; the password never reaches the socket, log or broadcast', async () => {
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', sudoAllowed: true })
    const tokenOf = (line: string) => line.match(/__srv_sudo''_(.+?)__/)![1]
    const { writes } = await setup({
      resolveSudoSecret: () => 'rootpw',
      script: (s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) { emit(s); emit(`__srv_sudo_${tokenOf(all[0])}__`) }
        else if (all.length === 2) emit(`\r\n__srv_done_${tokenOf(all[0])}__0\r\nroot@box:~# `)
      },
    })
    const sh = openShell('srv-a1?cols=80&rows=24&root=1')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    expect(writes[1]).toBe('rootpw\n')
    await sh.waitFor((f) => f.bin)
    expect(binText(sh.frames)).toBe('root@box:~# ')
    expect(logStore.get(ready.runId)).toMatchObject({ sudo: true, output: 'root@box:~# ' })
    expect(JSON.stringify(broadcasts)).not.toContain('rootpw')
    sh.ws.close()
    await sh.closed
    await sleep(30)
    expect(writes.at(-1)).toBe('sudo -k\n')
  })

  it('paste_secret at a password prompt writes <password>\\r, logs an accepted row, and redacts the secret from socket, log and broadcast', async () => {
    const { channel, writes } = await setup({
      resolveSudoSecret: () => 'hunter2',
      script: (s, _all, emit) => { if (s === 'hunter2\r') emit('hun'); },
    })
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    channel.emit('data', Buffer.from('\x1b[1m[sudo] password for u:\x1b[0m '))
    await sh.waitFor((f) => f.bin)
    sh.send({ t: 'paste_secret' })
    await sleep(30)
    expect(writes).toEqual(['hunter2\r'])
    // a fake echoing prompt: the rest of the secret arrives in a second chunk
    channel.emit('data', Buffer.from('ter2\r\nok\r\n'))
    await sh.waitFor((f) => f.bin && f.bin.toString().includes('ok'))
    expect(binText(sh.frames)).toBe('\x1b[1m[sudo] password for u:\x1b[0m [redacted]\r\nok\r\n')
    expect(logStore.get(ready.runId)!.output).toBe('\x1b[1m[sudo] password for u:\x1b[0m [redacted]\r\nok\r\n')
    expect(JSON.stringify(broadcasts)).not.toContain('hunter2')
    const audit = logStore.list().find((r) => r.command === 'paste_secret')!
    expect(audit).toMatchObject({ kind: 'exec', agentLabel: 'dashboard', exitCode: 0 })
    expect(logStore.get(audit.id)!.output).toBe('accepted\n')
    sh.ws.close()
    await sh.closed
  })

  it('paste_secret away from a prompt writes nothing, sends a toast, and logs a refused row', async () => {
    const { channel, writes } = await setup({ resolveSudoSecret: () => 'hunter2' })
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    channel.emit('data', Buffer.from('user@box:~$ '))
    await sh.waitFor((f) => f.bin)
    sh.send({ t: 'paste_secret' })
    const toast = await sh.waitFor((f) => f.t === 'toast')
    expect(toast.msg).toBe('The shell is not at a password prompt.')
    expect(writes).toEqual([])
    const audit = logStore.list().find((r) => r.command === 'paste_secret')!
    expect(audit.exitCode).toBe(1)
    expect(logStore.get(audit.id)!.output).toBe('refused: not at a prompt\n')
    sh.ws.close()
    await sh.closed
  })

  it('paste_secret with no resolvable password sends a toast and writes nothing', async () => {
    const { channel, writes } = await setup({ resolveSudoSecret: () => undefined })
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    channel.emit('data', Buffer.from('Password: '))
    await sh.waitFor((f) => f.bin)
    sh.send({ t: 'paste_secret' })
    const toast = await sh.waitFor((f) => f.t === 'toast')
    expect(toast.msg).toBe('No password is stored for this server.')
    expect(writes).toEqual([])
    sh.ws.close()
    await sh.closed
  })

  it('closes 4408 after the idle timeout with no keystrokes', async () => {
    const { channel } = await setup({ shellIdleTimeoutMs: 80 })
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    sh.send({ t: 'in', d: 'x' })
    await sleep(50)
    sh.send({ t: 'in', d: 'y' })   // keystrokes reset the timer
    await sleep(50)
    expect(sh.ws.readyState).toBe(WebSocket.OPEN)
    expect(await sh.closed).toEqual({ code: 4408, reason: 'closed after 4 h idle' })
    expect(channel.end).toHaveBeenCalled()
  })
  it('a second paste_secret before the remote prints anything is refused (stale prompt tail)', async () => {
    const { channel, writes } = await setup({ resolveSudoSecret: () => 'hunter2' })
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    channel.emit('data', Buffer.from('[sudo] password for u: '))
    await sh.waitFor((f) => f.bin)
    sh.send({ t: 'paste_secret' })
    sh.send({ t: 'paste_secret' })
    const toast = await sh.waitFor((f) => f.t === 'toast')
    expect(toast.msg).toBe('The shell is not at a password prompt.')
    expect(writes).toEqual(['hunter2\r'])
    sh.ws.close()
    await sh.closed
  })

  it('a multi-byte character split across two chunks reaches the log and the broadcast intact', async () => {
    const { channel } = await setup()
    const sh = openShell('srv-a1?cols=80&rows=24')
    await sh.opened
    const ready = await sh.waitFor((f) => f.t === 'ready')
    const check = Buffer.from('✓\n')
    channel.emit('data', check.subarray(0, 2))
    channel.emit('data', check.subarray(2))
    await sh.waitFor((f) => f.bin && f.bin.toString().includes('\n'))
    expect(binText(sh.frames)).toBe('✓\n')
    expect(logStore.get(ready.runId)!.output).toBe('✓\n')
    expect(broadcasts.filter((b) => b.type === 'stream').map((b) => b.chunk).join('')).toBe('✓\n')
    sh.ws.close()
    await sh.closed
  })

  it('a root shell forwards raw Buffers after priming, so a split character survives', async () => {
    registry.upsert({ id: 'srv-a1', host: 'h', port: 22, username: 'u', authMethod: 'password', sudoAllowed: true })
    const tokenOf = (line: string) => line.match(/__srv_sudo''_(.+?)__/)![1]
    const { channel } = await setup({
      resolveSudoSecret: () => 'rootpw',
      script: (s, all, emit) => {
        if (s.startsWith('sudo -k; sudo -p')) { emit(s); emit(`__srv_sudo_${tokenOf(all[0])}__`) }
        else if (all.length === 2) emit(`\r\n__srv_done_${tokenOf(all[0])}__0\r\n# `)
      },
    })
    const sh = openShell('srv-a1?cols=80&rows=24&root=1')
    await sh.opened
    await sh.waitFor((f) => f.t === 'ready')
    const check = Buffer.from('✓\n')
    channel.emit('data', check.subarray(0, 2))
    channel.emit('data', check.subarray(2))
    await sh.waitFor((f) => f.bin && f.bin.toString().includes('\n'))
    expect(binText(sh.frames)).toBe('# ✓\n')
    sh.ws.close()
    await sh.closed
  })
})
