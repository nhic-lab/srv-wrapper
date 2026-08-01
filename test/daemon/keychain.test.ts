import { describe, it, expect, vi } from 'vitest'
import { Keychain } from '../../src/daemon/keychain.js'

describe('Keychain', () => {
  it('setSecret shells out to security add-generic-password with the daemon binary as trusted app', () => {
    const runs: string[][] = []
    const fakeExec = (cmd: string, args: string[]) => {
      runs.push([cmd, ...args])
      return { stdout: '', status: 0 }
    }
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    kc.setSecret('srv-a1', 'hunter2')

    expect(runs[0][0]).toBe('security')
    expect(runs[0]).toContain('add-generic-password')
    expect(runs[0]).toContain('-a')
    expect(runs[0]).toContain('srv-a1')
    expect(runs[0]).toContain('-s')
    expect(runs[0]).toContain('srv-wrapper')
    expect(runs[0]).toContain('-w')
    expect(runs[0]).toContain('hunter2')
    expect(runs[0]).toContain('-T')
    expect(runs[0]).toContain('/usr/local/bin/srvd')
    expect(runs[0]).toContain('-U')
  })

  it('getSecret shells out to security find-generic-password and returns trimmed stdout', () => {
    const fakeExec = vi.fn().mockReturnValue({ stdout: 'hunter2\n', status: 0 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    const secret = kc.getSecret('srv-a1')

    expect(secret).toBe('hunter2')
    const args = fakeExec.mock.calls[0][1] as string[]
    expect(fakeExec.mock.calls[0][0]).toBe('security')
    expect(args).toContain('find-generic-password')
    expect(args).toContain('-w')
  })

  it('getSecret throws if the underlying command reports non-zero status', () => {
    const fakeExec = () => ({ stdout: '', status: 44 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    expect(() => kc.getSecret('missing')).toThrow()
  })

  it('deleteSecret shells out to security delete-generic-password', () => {
    const fakeExec = vi.fn().mockReturnValue({ stdout: '', status: 0 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    kc.deleteSecret('srv-a1')

    const args = fakeExec.mock.calls[0][1] as string[]
    expect(args).toContain('delete-generic-password')
    expect(args).toContain('srv-a1')
  })
})
