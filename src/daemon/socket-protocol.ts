export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n'
}

export function decodeMessages(buffer: string): { messages: object[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const messages: object[] = []
  for (const line of parts) {
    if (line.length === 0) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // malformed line — skip it rather than throwing and crashing the daemon
    }
  }
  return { messages, rest }
}
