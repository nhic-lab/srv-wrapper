#!/usr/bin/env node
import { Command } from 'commander'
import { execCommand } from './client.js'
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

program.parseAsync(process.argv)
