const REPLACEMENT = Buffer.from('[redacted]')

export interface Redactor {
  /** Returns the chunk with every occurrence of the secret replaced, possibly holding back a tail that could be the start of one. */
  filter(chunk: Buffer): Buffer
  /** Releases any held-back tail. Call when the window ends or the stream closes. */
  flush(): Buffer
  /** False once the window has lapsed (or the secret is empty); `filter` is then a pass-through. */
  readonly active: boolean
}

/**
 * The paste backstop. For `windowMs` after a password is pasted into a shell,
 * the exact bytes of that password are scrubbed from everything that leaves
 * the PTY — the browser socket, the audit log and the live broadcast — so a
 * prompt that echoes (a fake `echo -n "password: "`) does not leak it. The
 * secret may straddle two output chunks, so up to `secret.length - 1` trailing
 * bytes that are a prefix of it are held back until the next chunk decides.
 */
export function createRedactor(secret: string, windowMs: number, now: () => number = Date.now): Redactor {
  const needle = Buffer.from(secret, 'utf8')
  const until = now() + windowMs
  let held: Buffer = Buffer.alloc(0)

  const isActive = () => needle.length > 0 && now() <= until

  /** Length of the longest suffix of `buf` that is a proper prefix of the secret. */
  function pendingPrefixLength(buf: Buffer): number {
    const max = Math.min(buf.length, needle.length - 1)
    for (let len = max; len > 0; len--) {
      if (buf.subarray(buf.length - len).equals(needle.subarray(0, len))) return len
    }
    return 0
  }

  return {
    get active() {
      return isActive()
    },
    filter(chunk: Buffer): Buffer {
      if (!isActive()) {
        if (held.length === 0) return chunk
        const out = Buffer.concat([held, chunk])
        held = Buffer.alloc(0)
        return out
      }
      let buf = held.length ? Buffer.concat([held, chunk]) : chunk
      held = Buffer.alloc(0)
      const parts: Buffer[] = []
      let from = 0
      for (;;) {
        const at = buf.indexOf(needle, from)
        if (at === -1) break
        parts.push(buf.subarray(from, at), REPLACEMENT)
        from = at + needle.length
      }
      let rest = buf.subarray(from)
      const keep = pendingPrefixLength(rest)
      if (keep > 0) {
        held = Buffer.from(rest.subarray(rest.length - keep))
        rest = rest.subarray(0, rest.length - keep)
      }
      parts.push(rest)
      return Buffer.concat(parts)
    },
    flush(): Buffer {
      const out = held
      held = Buffer.alloc(0)
      return out
    },
  }
}
