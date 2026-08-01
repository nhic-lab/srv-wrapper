export type AuthMethod = 'password' | 'key'

export interface ServerRecord {
  id: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  createdAt: number
  updatedAt: number
}

export type RunKind = 'exec' | 'session'

export interface RunRecord {
  id: string
  serverId: string
  agentLabel: string
  kind: RunKind
  command: string | null
  output: string
  exitCode: number | null
  startedAt: number
  endedAt: number | null
}

export interface ExecRequest {
  type: 'exec'
  serverId: string
  agentLabel: string
  command: string
}

export interface SessionStartRequest {
  type: 'session_start'
  serverId: string
  agentLabel: string
}

export interface SessionSendRequest {
  type: 'session_send'
  sessionId: string
  command: string
}

export interface SessionStopRequest {
  type: 'session_stop'
  sessionId: string
}

export type DaemonRequest =
  | ExecRequest
  | SessionStartRequest
  | SessionSendRequest
  | SessionStopRequest

export interface StreamEvent {
  type: 'stream'
  requestId: string
  stream: 'stdout' | 'stderr'
  chunk: string
}

export interface DoneEvent {
  type: 'done'
  requestId: string
  exitCode: number | null
  error?: string
}

export interface SessionStartedEvent {
  type: 'session_started'
  requestId: string
  sessionId: string
}

export type DaemonEvent = StreamEvent | DoneEvent | SessionStartedEvent
