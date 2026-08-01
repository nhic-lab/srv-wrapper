#!/usr/bin/env node
import { Command } from 'commander'
import { execCommand, sessionStart, sessionSend, sessionStop } from './client.js'
import { srvSocketPath } from '../shared/paths.js'

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

program.parseAsync(process.argv)
