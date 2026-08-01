import { spawnSync } from 'node:child_process'

const SERVICE = 'srv-wrapper'

export type ExecFn = (cmd: string, args: string[]) => { stdout: string; status: number }

function defaultExec(cmd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' })
  return { stdout: result.stdout ?? '', status: result.status ?? 1 }
}

export class Keychain {
  constructor(
    private daemonBinaryPath: string,
    private exec: ExecFn = defaultExec
  ) {}

  setSecret(serverId: string, secret: string): void {
    const result = this.exec('security', [
      'add-generic-password',
      '-a', serverId,
      '-s', SERVICE,
      '-w', secret,
      '-T', this.daemonBinaryPath,
      '-U',
    ])
    if (result.status !== 0) {
      throw new Error(`Failed to store secret for ${serverId} in Keychain (status ${result.status})`)
    }
  }

  getSecret(serverId: string): string {
    const result = this.exec('security', [
      'find-generic-password',
      '-a', serverId,
      '-s', SERVICE,
      '-w',
    ])
    if (result.status !== 0) {
      throw new Error(`No secret found for ${serverId} in Keychain (status ${result.status})`)
    }
    return result.stdout.trim()
  }

  deleteSecret(serverId: string): void {
    this.exec('security', [
      'delete-generic-password',
      '-a', serverId,
      '-s', SERVICE,
    ])
  }
}
