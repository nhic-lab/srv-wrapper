import { describe, it, expect } from 'vitest'
import { encodeMessage, decodeMessages } from '../../src/daemon/socket-protocol.js'

describe('socket-protocol', () => {
  it('encodeMessage serializes to JSON followed by a newline', () => {
    expect(encodeMessage({ a: 1 })).toBe('{"a":1}\n')
  })

  it('decodeMessages parses one complete message and leaves no remainder', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n')
    expect(messages).toEqual([{ a: 1 }])
    expect(rest).toBe('')
  })

  it('decodeMessages parses multiple messages arriving in one chunk', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n{"b":2}\n')
    expect(messages).toEqual([{ a: 1 }, { b: 2 }])
    expect(rest).toBe('')
  })

  it('decodeMessages holds back an incomplete trailing message', () => {
    const { messages, rest } = decodeMessages('{"a":1}\n{"b":2')
    expect(messages).toEqual([{ a: 1 }])
    expect(rest).toBe('{"b":2')
  })

  it('decodeMessages skips a malformed JSON line instead of throwing', () => {
    const { messages, rest } = decodeMessages('not json at all\n{"a":1}\n')
    expect(messages).toEqual([{ a: 1 }])
    expect(rest).toBe('')
  })
})
