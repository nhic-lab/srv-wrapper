import { randomUUID } from 'node:crypto'
import type { ServerRecord } from '../shared/types.js'

/**
 * Raised by the sudo paths in SshManager. Carries no host information, so the
 * socket server passes it to the client unsanitized — unlike raw ssh2 errors.
 */
export class SudoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SudoError'
  }
}

/** POSIX single-quoting: the only characters that need care are single quotes themselves. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The exec-mode wrapper. Every flag is load-bearing — see the design spec:
 *   -S            read the password from stdin
 *   -k            ignore any cached timestamp, so sudo ALWAYS consumes the
 *                 password line we are about to write
 *   -p ''         no prompt text on stderr
 *   exec </dev/null  the leak guard: if sudo did not prompt after all
 *                 (NOPASSWD), the unread password line must never reach the
 *                 command's stdin, where `cat` would print it into the log
 */
export function buildSudoExecCommand(command: string): string {
  return `sudo -S -k -p '' -- sh -c ${shellSingleQuote('exec </dev/null; ' + command)}`
}

export interface PrimerResult {
  /** Write `<password>\n` to the channel now. Reported at most once. */
  writePassword: boolean
  /** Present once the priming command has finished; `ok` means `sudo -v` exited 0. */
  done?: { ok: boolean }
  /** Output after the done line, i.e. the first bytes that belong to the real session. */
  passthrough: string
}

export interface SudoPrimer {
  /** The line to write to the shell, newline included. */
  readonly commandLine: string
  feed(chunk: string): PrimerResult
}

/**
 * Session-mode priming state machine. The shell is a PTY, so it echoes the
 * command line back before sudo prints anything. Both sentinels are therefore
 * written SPLIT (`'__srv_sudo''_<token>__'`) and matched JOINED: the echo can
 * never match, only sudo's prompt and the echo command's output can. Without
 * this the password would be written on the echo, before sudo decided whether
 * to prompt, and on a NOPASSWD box it would run as a shell command.
 */
export function createSudoPrimer(token: string = randomUUID()): SudoPrimer {
  const prompt = `__srv_sudo_${token}__`
  const done = `__srv_done_${token}__`
  const split = (sentinel: string) => sentinel.replace('_' + token, `''_` + token)
  const commandLine = `sudo -k; sudo -p '${split(prompt)}' -v; echo '${split(done)}'$?\n`
  const doneLine = new RegExp(`${done}(\\d+)\\r?\\n`)

  let buffer = ''
  let passwordSent = false

  return {
    commandLine,
    feed(chunk: string): PrimerResult {
      buffer += chunk
      let writePassword = false
      const firstPrompt = buffer.indexOf(prompt)
      if (!passwordSent && firstPrompt !== -1) {
        passwordSent = true
        writePassword = true
      }
      // sudo re-prompts on a wrong password (passwd_tries defaults to 3) rather
      // than exiting, so a second joined prompt is the rejection signal.
      if (passwordSent && !writePassword && buffer.indexOf(prompt, firstPrompt + prompt.length) !== -1) {
        buffer = ''
        return { writePassword: false, done: { ok: false }, passthrough: '' }
      }
      const m = doneLine.exec(buffer)
      if (!m) return { writePassword, passthrough: '' }
      const passthrough = buffer.slice(m.index + m[0].length)
      buffer = ''
      return { writePassword, done: { ok: m[1] === '0' }, passthrough }
    },
  }
}

/**
 * The sudo gate, shared by the agent socket and the browser shell. Both
 * refusals happen before any SSH connection is made; callers record them in
 * the audit log so the history shows who tried.
 */
export function gateSudo(
  server: ServerRecord,
  resolve: ((server: ServerRecord) => string | undefined) | undefined
): string | { refusal: string } {
  if (!server.sudoAllowed) return { refusal: `sudo is not enabled for ${server.id}` }
  let password: string | undefined
  try {
    password = resolve?.(server)
  } catch (err) {
    // e.g. a password-auth server whose login secret is missing from Keychain.
    // The raw message may name Keychain internals; the refusal is what the client sees.
    console.error(`srvd: sudo secret lookup failed for ${server.id}:`, err)
    password = undefined
  }
  if (password === undefined) return { refusal: `sudo error: no sudo password stored for ${server.id}` }
  return password
}

// CSI / OSC / single-char escape sequences, enough for prompt colouring.
const ANSI = /\x1b\[[0-?]*[ -\/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// CSI finals that move the cursor or erase: a full-screen app (vim, less) uses
// these between a buffer line and its own ':' prompt. Deleting them would glue
// "…Password…" and ":" together and fool the guard, so they become line breaks.
const POSITIONING = new Set(['H', 'f', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'd', 'J', 'K', 'S', 'T'])

export function stripAnsi(s: string): string {
  return s.replace(ANSI, (_m, final?: string) => (final && POSITIONING.has(final) ? '\n' : ''))
}

/** A prompt that is waiting for a secret: ends in "password…:" or "passphrase…:" with nothing after it but spaces. */
export const PASSWORD_PROMPT = /(password|passphrase)[^\r\n]{0,80}:[ \t]*$/i

/** The browser shell's paste guard. `tail` must already be ANSI-stripped. */
export function isPasswordPrompt(tail: string): boolean {
  return PASSWORD_PROMPT.test(tail)
}
