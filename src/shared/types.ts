export type AuthMethod = 'password' | 'key'

export interface ServerRecord {
  id: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  hostKeyFingerprint?: string
  jumpChain?: string[]
  createdAt: number
  updatedAt: number
  /** Last reachability check, persisted so the online/offline filter survives
   *  a refresh or daemon restart. Absent until the server has been tested. */
  lastTestAt?: number
  lastTestOk?: boolean
  lastTestError?: string
  /** Human-set switch: may an agent pass --sudo for this server. Off by default. */
  sudoAllowed?: boolean
  /** Whether a separate `<id>:sudo` Keychain entry exists. Mirrored in the
   *  registry so the dashboard never has to poll Keychain per server. */
  hasSudoSecret?: boolean
}

export type RunKind = 'exec' | 'session' | 'shell'

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
  /** Total bytes the command produced, including any elided by the output cap. */
  outputBytes: number
  /** True when `output` is a head+tail extract rather than the whole stream. */
  truncated: boolean
  /** True when the command ran as root via the daemon-fed sudo path. */
  sudo: boolean
}

/** Run metadata without `output` — what the dashboard's list pane consumes. */
export interface RunSummary {
  id: string
  serverId: string
  agentLabel: string
  kind: RunKind
  command: string | null
  exitCode: number | null
  startedAt: number
  endedAt: number | null
  outputBytes: number
  truncated: boolean
  hasOutput: boolean
  sudo: boolean
}

export interface ExecRequest {
  type: 'exec'
  serverId: string
  agentLabel: string
  command: string
  /** Kill the command and report an error if it runs longer than this. Absent/0 means no timeout. */
  timeoutMs?: number
  /** Run as root via the daemon-fed sudo path. Refused unless the server has sudoAllowed. */
  sudo?: boolean
}

export interface ListStatusRequest {
  type: 'list_status'
}

export interface ServerStatus {
  id: string
  reachable: boolean
  /** Already-sanitized classification (timeout/refused/dns/etc) — absent when reachable. */
  error?: string
  /** Set to the first-registered id sharing the same host:port, when this id is a later duplicate. */
  duplicateOf?: string
}

export interface SessionStartRequest {
  type: 'session_start'
  serverId: string
  agentLabel: string
  /** Prime sudo's timestamp cache in the new shell. Refused unless the server has sudoAllowed. */
  sudo?: boolean
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

export interface ListRequest {
  type: 'list'
}

export type DaemonRequest =
  | ExecRequest
  | SessionStartRequest
  | SessionSendRequest
  | SessionStopRequest
  | ListRequest
  | ListStatusRequest

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
  /** True only for a connection/transport failure where the command never ran — the signal
   *  the CLI's --retry uses to decide whether retrying is safe (a timeout or an exec that
   *  already ran must never be retried blindly). Absent/false otherwise. */
  retryable?: boolean
}

export interface SessionStartedEvent {
  type: 'session_started'
  requestId: string
  sessionId: string
}

export interface ListResultEvent {
  type: 'list_result'
  requestId: string
  serverIds: string[]
}

export interface ListStatusResultEvent {
  type: 'list_status_result'
  requestId: string
  results: ServerStatus[]
}

export type DaemonEvent = StreamEvent | DoneEvent | SessionStartedEvent | ListResultEvent | ListStatusResultEvent
