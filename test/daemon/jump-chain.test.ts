import { describe, it, expect } from 'vitest'
import { resolveJumpPath } from '../../src/daemon/jump-chain.js'
import type { ServerRecord } from '../../src/shared/types.js'

function rec(id: string, jumpChain?: string[]): ServerRecord {
  return {
    id,
    host: `${id}.example`,
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    jumpChain,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('resolveJumpPath', () => {
  it('resolves a simple valid chain in connection order, target last', () => {
    const registry = new Map<string, ServerRecord>([
      ['bastion-1', rec('bastion-1')],
      ['bastion-2', rec('bastion-2')],
    ])
    const path = resolveJumpPath('target', ['bastion-1', 'bastion-2'], (id) => registry.get(id))
    expect(path).toEqual(['bastion-1', 'bastion-2', 'target'])
  })

  it('throws when a chain references an unknown server id', () => {
    expect(() => resolveJumpPath('target', ['ghost'], () => undefined)).toThrow(/unknown server id "ghost"/)
  })

  it('throws on a direct self-reference', () => {
    expect(() => resolveJumpPath('target', ['target'], () => undefined)).toThrow(/"target"/)
  })

  it('throws on an indirect cycle A -> B -> A', () => {
    const registry = new Map<string, ServerRecord>([['bastion-b', rec('bastion-b', ['target'])]])
    expect(() => resolveJumpPath('target', ['bastion-b'], (id) => registry.get(id))).toThrow(/"target"/)
  })

  it('recursively expands a jump host that itself has its own jumpChain', () => {
    const registry = new Map<string, ServerRecord>([
      ['gateway', rec('gateway')],
      ['bastion-1', rec('bastion-1', ['gateway'])],
    ])
    const path = resolveJumpPath('target', ['bastion-1'], (id) => registry.get(id))
    expect(path).toEqual(['gateway', 'bastion-1', 'target'])
  })

  it('empty proposed chain resolves to just the target', () => {
    expect(resolveJumpPath('target', [], () => undefined)).toEqual(['target'])
  })
})
