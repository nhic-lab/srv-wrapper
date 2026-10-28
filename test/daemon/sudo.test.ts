import { describe, it, expect } from 'vitest'
import { shellSingleQuote, buildSudoExecCommand, createSudoPrimer, SudoError } from '../../src/daemon/sudo.js'

describe('shellSingleQuote / buildSudoExecCommand', () => {
  it('wraps with the leak guard and -k, and never alters the command bytes', () => {
    const cmd = `echo 'it'"'"'s $HOME \`date\`\nls`
    const out = buildSudoExecCommand(cmd)
    expect(out.startsWith(`sudo -S -k -p '' -- sh -c '`)).toBe(true)
    expect(out).toContain(`exec </dev/null; `)
    expect(out).toBe(`sudo -S -k -p '' -- sh -c ${shellSingleQuote('exec </dev/null; ' + cmd)}`)
    expect(shellSingleQuote(`it's`)).toBe(`'it'\\''s'`)
  })

  it('SudoError carries its message and name', () => {
    const err = new SudoError('sudo error: authentication failed')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SudoError')
    expect(err.message).toBe('sudo error: authentication failed')
  })
})

describe('createSudoPrimer', () => {
  const token = 'abc'

  it('writes the sentinels split in the command line so the PTY echo never contains them joined', () => {
    const p = createSudoPrimer(token)
    expect(p.commandLine).toBe(`sudo -k; sudo -p '__srv_sudo''_abc__' -v; echo '__srv_done''_abc__'$?\n`)
    expect(p.commandLine).not.toContain('__srv_sudo_abc__')
    expect(p.commandLine).not.toContain('__srv_done_abc__')
  })

  it('does not write the password in response to the echoed command line', () => {
    const p = createSudoPrimer(token)
    expect(p.feed(p.commandLine).writePassword).toBe(false)
  })

  it('writes the password exactly once when the joined prompt sentinel appears, even split across chunks', () => {
    const p = createSudoPrimer(token)
    expect(p.feed('__srv_su').writePassword).toBe(false)
    expect(p.feed('do_abc__').writePassword).toBe(true)
    expect(p.feed('__srv_sudo_abc__').writePassword).toBe(false)
  })

  it('reports done ok with passthrough after the done line, without ever asking for the password on NOPASSWD boxes', () => {
    const p = createSudoPrimer(token)
    const r = p.feed('__srv_done_abc__0\r\nuser@host:~$ ')
    expect(r.writePassword).toBe(false)
    expect(r.done).toEqual({ ok: true })
    expect(r.passthrough).toBe('user@host:~$ ')
  })

  it('reports done not-ok on a non-zero code', () => {
    const p = createSudoPrimer(token)
    p.feed('__srv_sudo_abc__')
    expect(p.feed('Sorry, try again.\n__srv_done_abc__1\n').done).toEqual({ ok: false })
  })

  it('does not report done until the exit code line is complete', () => {
    const p = createSudoPrimer(token)
    expect(p.feed('__srv_done_abc__').done).toBeUndefined()
    expect(p.feed('0').done).toBeUndefined()
    expect(p.feed('\n').done).toEqual({ ok: true })
  })

  it('uses a random token by default', () => {
    expect(createSudoPrimer().commandLine).not.toBe(createSudoPrimer().commandLine)
  })
})
