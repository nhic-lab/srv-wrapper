import { describe, it, expect } from 'vitest'
import { createRedactor } from '../../src/daemon/redact.js'

describe('createRedactor', () => {
  it('replaces the secret inside the window and passes other bytes through', () => {
    const r = createRedactor('hunter2', 2000, () => 0)
    expect(r.filter(Buffer.from('ok hunter2 done\n')).toString()).toBe('ok [redacted] done\n')
    expect(r.filter(Buffer.from('plain\n')).toString()).toBe('plain\n')
  })

  it('redacts a secret split across two chunks', () => {
    const r = createRedactor('hunter2', 2000, () => 0)
    const a = r.filter(Buffer.from('x hun'))
    const b = r.filter(Buffer.from('ter2 y'))
    expect(a.toString() + b.toString()).toBe('x [redacted] y')
  })

  it('redacts two occurrences in one chunk', () => {
    const r = createRedactor('hunter2', 2000, () => 0)
    expect(r.filter(Buffer.from('hunter2hunter2!\n')).toString()).toBe('[redacted][redacted]!\n')
  })

  it('releases held-back bytes on flush when they were not the secret', () => {
    const r = createRedactor('hunter2', 2000, () => 0)
    expect(r.filter(Buffer.from('ab hun')).toString()).toBe('ab ')
    expect(r.flush().toString()).toBe('hun')
  })

  it('is inert after the window', () => {
    let t = 0
    const r = createRedactor('hunter2', 2000, () => t)
    expect(r.active).toBe(true)
    t = 2001
    expect(r.active).toBe(false)
    expect(r.filter(Buffer.from('hunter2')).toString()).toBe('hunter2')
  })

  it('never redacts with an empty secret', () => {
    const r = createRedactor('', 2000)
    expect(r.filter(Buffer.from('abc')).toString()).toBe('abc')
    expect(r.active).toBe(false)
  })
})
