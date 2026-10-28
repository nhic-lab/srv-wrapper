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
  it('setSudoSecret stores under the "<id>:sudo" account, independent of the login entry', () => {
    const runs: string[][] = []
    const kc = new Keychain('/usr/local/bin/srvd', (cmd, args) => { runs.push([cmd, ...args]); return { stdout: '', status: 0 } })
    kc.setSudoSecret('srv-a1', 'rootpw')
    expect(runs[0]).toContain('add-generic-password')
    expect(runs[0][runs[0].indexOf('-a') + 1]).toBe('srv-a1:sudo')
    expect(runs[0]).toContain('rootpw')
  })

  it('getSudoSecret reads the "<id>:sudo" account and throws when absent', () => {
    const fakeExec = vi.fn().mockReturnValueOnce({ stdout: 'rootpw\n', status: 0 }).mockReturnValueOnce({ stdout: '', status: 44 })
    const kc = new Keychain('/usr/local/bin/srvd', fakeExec)
    expect(kc.getSudoSecret('srv-a1')).toBe('rootpw')
    expect(fakeExec.mock.calls[0][1] as string[]).toContain('srv-a1:sudo')
    expect(() => kc.getSudoSecret('srv-a1')).toThrow(/sudo/)
  })

  it('deleteSudoSecret targets the "<id>:sudo" account only', () => {
    const runs: string[][] = []
    const kc = new Keychain('/usr/local/bin/srvd', (cmd, args) => { runs.push([cmd, ...args]); return { stdout: '', status: 0 } })
    kc.deleteSudoSecret('srv-a1')
    expect(runs[0]).toContain('delete-generic-password')
    expect(runs[0][runs[0].indexOf('-a') + 1]).toBe('srv-a1:sudo')
  })
})
