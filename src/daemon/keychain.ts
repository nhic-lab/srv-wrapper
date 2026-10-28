import { spawnSync } from 'node:child_process'

const SERVICE = 'srv-wrapper'

export type ExecFn = (cmd: string, args: string[]) => { stdout: string; status: number }

function defaultExec(cmd: string, args: string[]): { stdout: string; status: number } {
  const result = spawnSync(cmd, args, { encoding: 'utf-8' })
  return { stdout: result.stdout ?? '', status: result.status ?? 1 }
}

/** Account name of the optional, separate sudo password for a server. */
function sudoAccount(serverId: string): string {
  return `${serverId}:sudo`
}

export class Keychain {
  constructor(
    private daemonBinaryPath: string,
    private exec: ExecFn = defaultExec
  ) {}

  setSecret(serverId: string, secret: string): void {
    this.add(serverId, secret, `Failed to store secret for ${serverId} in Keychain`)
  }

  getSecret(serverId: string): string {
    return this.find(serverId, `No secret found for ${serverId} in Keychain`)
  }

  deleteSecret(serverId: string): void {
    this.remove(serverId)
  }

  setSudoSecret(serverId: string, secret: string): void {
    this.add(sudoAccount(serverId), secret, `Failed to store sudo secret for ${serverId} in Keychain`)
  }

  getSudoSecret(serverId: string): string {
    return this.find(sudoAccount(serverId), `No sudo secret found for ${serverId} in Keychain`)
  }

  deleteSudoSecret(serverId: string): void {
    this.remove(sudoAccount(serverId))
  }

  private add(account: string, secret: string, failureMessage: string): void {
    const result = this.exec('security', [
      'add-generic-password',
      '-a', account,
      '-s', SERVICE,
      '-w', secret,
      '-T', this.daemonBinaryPath,
      '-U',
    ])
    if (result.status !== 0) {
      throw new Error(`${failureMessage} (status ${result.status})`)
    }
  }

  private find(account: string, failureMessage: string): string {
    const result = this.exec('security', [
      'find-generic-password',
      '-a', account,
      '-s', SERVICE,
      '-w',
    ])
    if (result.status !== 0) {
      throw new Error(`${failureMessage} (status ${result.status})`)
    }
    return result.stdout.trim()
  }

  private remove(account: string): void {
    this.exec('security', [
      'delete-generic-password',
      '-a', account,
      '-s', SERVICE,
    ])
  }
}
