import { describe, it, expect } from 'vitest'
import { srvHome, srvSocketPath, srvRegistryDbPath, srvLogDbPath, srvKeysDir } from '../../src/shared/paths.js'
import { homedir } from 'node:os'
import path from 'node:path'

describe('paths', () => {
  it('srvHome resolves to ~/.srv', () => {
    expect(srvHome()).toBe(path.join(homedir(), '.srv'))
  })

  it('srvSocketPath resolves inside srvHome', () => {
    expect(srvSocketPath()).toBe(path.join(srvHome(), 'srv.sock'))
  })

  it('srvRegistryDbPath and srvLogDbPath are distinct files inside srvHome', () => {
    expect(srvRegistryDbPath()).toBe(path.join(srvHome(), 'registry.db'))
    expect(srvLogDbPath()).toBe(path.join(srvHome(), 'log.db'))
  })

  it('srvKeysDir resolves inside srvHome', () => {
    expect(srvKeysDir()).toBe(path.join(srvHome(), 'keys'))
  })
})
