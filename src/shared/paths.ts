import { homedir } from 'node:os'
import path from 'node:path'

export function srvHome(): string {
  return path.join(homedir(), '.srv')
}

export function srvSocketPath(): string {
  return path.join(srvHome(), 'srv.sock')
}

export function srvRegistryDbPath(): string {
  return path.join(srvHome(), 'registry.db')
}

export function srvLogDbPath(): string {
  return path.join(srvHome(), 'log.db')
}

export function srvKeysDir(): string {
  return path.join(srvHome(), 'keys')
}
