#!/usr/bin/env node
import { Command } from 'commander'
import { execCommand, execMany, sessionStart, sessionSend, sessionStop, listServers, listStatus, withRetry } from './client.js'
import { srvSocketPath } from '../shared/paths.js'
import { installLaunchd, uninstallLaunchd, daemonStatus } from './daemon-install.js'

const program = new Command()

program
  .name('srv')
  .description('Run commands on registered servers by id, without ever seeing host/credentials')

/** `0` (or omitted) disables the timeout; otherwise converts the CLI's seconds to ms. Exits with a
 *  clear error on unparsable input rather than silently falling back to "no timeout". */
function parseTimeoutMs(seconds: string): number | undefined {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`srv: --timeout must be a non-negative number of seconds, got "${seconds}"\n`)
    process.exit(1)
  }
  return n > 0 ? n * 1000 : undefined
}

/** Exits with a clear error on unparsable input rather than silently falling back to a default. */
function parseNonNegativeInt(value: string, flag: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    process.stderr.write(`srv: ${flag} must be a non-negative whole number, got "${value}"\n`)
    process.exit(1)
  }
  return n
}

/**
 * Tags each server's output with `[serverId]`, buffering per (serverId, stream) pair so a chunk
 * boundary that falls mid-line never produces a merged or mistagged line when several servers'
 * output is interleaved on the same stdout/stderr. Call `flush()` once all servers are done to
 * emit any trailing partial line that never got a terminating newline.
 */
function createLineTagger() {
  interface Entry { serverId: string; pending: string; write: (s: string) => void }
  const entries = new Map<string, Entry>()

  function push(serverId: string, stream: 'stdout' | 'stderr', chunk: string): void {
    const key = `${serverId}:${stream}`
    let entry = entries.get(key)
    if (!entry) {
      entry = { serverId, pending: '', write: (s) => (stream === 'stdout' ? process.stdout : process.stderr).write(s) }
      entries.set(key, entry)
    }
    const lines = (entry.pending + chunk).split('\n')
    entry.pending = lines.pop() ?? ''
    for (const line of lines) entry.write(`[${entry.serverId}] ${line}\n`)
  }

  function flush(): void {
    for (const entry of entries.values()) {
      if (entry.pending.length > 0) entry.write(`[${entry.serverId}] ${entry.pending}\n`)
    }
    entries.clear()
  }

  return { push, flush }
}

program
  .command('exec <server-id> <command>')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .option('--timeout <seconds>', 'kill the command if it runs longer than this many seconds (0 disables)', '120')
  .option('--retry <n>', 'retry on connection/transport failure only (not on a non-zero exit), immediately, this many times', '0')
  .action(async (serverId: string, command: string, options: { agent: string; timeout: string; retry: string }) => {
    try {
      const timeoutMs = parseTimeoutMs(options.timeout)
      const retries = parseNonNegativeInt(options.retry, '--retry')
      const exitCode = await withRetry(
        () =>
          execCommand({
            socketPath: srvSocketPath(),
            serverId,
            agentLabel: options.agent,
            command,
            timeoutMs,
            onStream: (stream, chunk) => {
              (stream === 'stdout' ? process.stdout : process.stderr).write(chunk)
            },
          }),
        retries
      )
      process.exit(exitCode)
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

program
  .command('exec-many <server-ids> <command>')
  .description('Run a command on multiple servers concurrently (server-ids is a comma-separated list)')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .option('--parallel <n>', 'max number of servers to run concurrently', '4')
  .option('--timeout <seconds>', 'kill each command if it runs longer than this many seconds (0 disables)', '120')
  .option('--retry <n>', 'retry a server\'s command on connection/transport failure only, immediately, this many times', '0')
  .action(async (serverIdsArg: string, command: string, options: { agent: string; parallel: string; timeout: string; retry: string }) => {
    const serverIds = serverIdsArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (serverIds.length === 0) {
      process.stderr.write('srv: exec-many requires at least one server id\n')
      process.exit(1)
    }

    const parallel = parseNonNegativeInt(options.parallel, '--parallel')
    if (parallel === 0) {
      process.stderr.write('srv: --parallel must be at least 1\n')
      process.exit(1)
    }
    const retries = parseNonNegativeInt(options.retry, '--retry')
    const tagger = createLineTagger()

    const results = await execMany({
      socketPath: srvSocketPath(),
      serverIds,
      agentLabel: options.agent,
      command,
      parallel,
      timeoutMs: parseTimeoutMs(options.timeout),
      retries,
      onStream: (serverId, stream, chunk) => tagger.push(serverId, stream, chunk),
    })
    tagger.flush()

    let anyFailed = false
    for (const r of results) {
      if (r.error) {
        anyFailed = true
        process.stderr.write(`[${r.serverId}] failed: ${r.error}\n`)
      } else if (r.exitCode !== 0) {
        anyFailed = true
        process.stderr.write(`[${r.serverId}] exited ${r.exitCode}\n`)
      }
    }
    process.exit(anyFailed ? 1 : 0)
  })

program
  .command('list')
  .description('List all registered server ids')
  .option('--status', 'also check reachability and flag duplicate registrations (same host:port)')
  .action(async (options: { status?: boolean }) => {
    try {
      if (options.status) {
        const results = await listStatus({ socketPath: srvSocketPath() })
        for (const r of results) {
          const statusLabel = r.reachable ? 'reachable' : `unreachable (${r.error ?? 'unknown error'})`
          const dupLabel = r.duplicateOf ? `  [duplicate of ${r.duplicateOf}]` : ''
          process.stdout.write(`${r.id}\t${statusLabel}${dupLabel}\n`)
        }
      } else {
        const serverIds = await listServers({ socketPath: srvSocketPath() })
        for (const id of serverIds) process.stdout.write(id + '\n')
      }
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

const session = program.command('session').description('Manage a persistent interactive session on a server')

session
  .command('start <server-id>')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .action(async (serverId: string, options: { agent: string }) => {
    const sessionId = await sessionStart({ socketPath: srvSocketPath(), serverId, agentLabel: options.agent })
    process.stdout.write(sessionId + '\n')
  })

session
  .command('send <session-id> <command>')
  .action(async (sessionId: string, command: string) => {
    await sessionSend({
      socketPath: srvSocketPath(), sessionId, command: command + '\n',
      onStream: (stream, chunk) => (stream === 'stdout' ? process.stdout : process.stderr).write(chunk),
    })
  })

session
  .command('stop <session-id>')
  .action(async (sessionId: string) => {
    await sessionStop({ socketPath: srvSocketPath(), sessionId })
  })

const daemon = program.command('daemon').description('Manage the srvd background daemon')

daemon
  .command('install')
  .description('Install and start srvd as a launchd agent that runs on login (macOS only)')
  .action(() => {
    try {
      installLaunchd()
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

daemon
  .command('uninstall')
  .description('Remove the srvd launchd agent')
  .action(() => {
    try {
      uninstallLaunchd()
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

daemon
  .command('status')
  .description('Show whether the srvd launchd agent is loaded')
  .action(() => {
    try {
      daemonStatus()
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

program.parseAsync(process.argv)
