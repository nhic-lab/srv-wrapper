export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n'
}

export function decodeMessages(buffer: string): { messages: object[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const messages = parts.filter((line) => line.length > 0).map((line) => JSON.parse(line))
  return { messages, rest }
}
