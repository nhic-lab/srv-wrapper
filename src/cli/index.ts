#!/usr/bin/env node
import { Command } from 'commander'
import { execCommand, sessionStart, sessionSend, sessionStop, listServers } from './client.js'
import { srvSocketPath } from '../shared/paths.js'
import { installLaunchd, uninstallLaunchd, daemonStatus } from './daemon-install.js'

const program = new Command()

program
  .name('srv')
  .description('Run commands on registered servers by id, without ever seeing host/credentials')

program
  .command('exec <server-id> <command>')
  .requiredOption('--agent <label>', 'label identifying the calling agent/session')
  .action(async (serverId: string, command: string, options: { agent: string }) => {
    try {
      const exitCode = await execCommand({
        socketPath: srvSocketPath(),
        serverId,
        agentLabel: options.agent,
        command,
        onStream: (stream, chunk) => {
          (stream === 'stdout' ? process.stdout : process.stderr).write(chunk)
        },
      })
      process.exit(exitCode)
    } catch (err: any) {
      process.stderr.write(`srv: ${err.message}\n`)
      process.exit(1)
    }
  })

program
  .command('list')
  .description('List all registered server ids')
  .action(async () => {
    try {
      const serverIds = await listServers({ socketPath: srvSocketPath() })
      for (const id of serverIds) process.stdout.write(id + '\n')
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
