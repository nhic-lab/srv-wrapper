# SSH Wrapper for AI Agents — Design

## Purpose

Give AI coding agents (e.g. Claude Code sessions) the ability to run commands on registered servers via an opaque `server-id`, without ever exposing the real hostname/IP, port, username, or password/key material to the agent. Provide a local browser dashboard to watch what agents are doing live and review history afterward.

## Goals

- Agents reference servers only by ID; the wrapper resolves ID → real connection details internally.
- Support both one-shot commands and persistent interactive sessions.
- Live view (in-browser) of what every agent is currently running, across concurrent agents.
- Persistent, searchable history/audit log of past commands and output.
- GUI-based server registration: single-entry form and bulk JSON import.
- A documented Claude Code skill so agents know how to use the wrapper correctly.

## Non-goals (v1)

- Command allowlisting/denylisting or approval gating — full shell access once connected via ID (relies on live/audit visibility, not command-level restriction).
- Remote (non-localhost) dashboard access or multi-user auth.
- Kill/pause controls from the dashboard (observation-only).

## Architecture

Four components, all local to the user's Mac, coordinated by a single background daemon:

1. **`srvd` (daemon)** — Node.js/TypeScript background process, managed by `launchd` (auto-starts on login). Exposes a `127.0.0.1`-only HTTP + WebSocket API (no external network exposure). Holds the only code path that ever touches real hostnames/IPs/credentials.
2. **`srv` (CLI)** — thin client invoked by agents. Never receives secrets; sends `{serverId, command, agentLabel}` (or session equivalents) to the daemon and streams back output/exit code.
3. **Registry** — SQLite database at `~/.srv/registry.db` storing server metadata (id, host, port, username, auth method). Actual secrets (passwords, key passphrases) are stored in the macOS Keychain, referenced by server id. Private key files live under `~/.srv/keys/` with `0600` permissions.
4. **Dashboard** — Express + WebSocket server bound to `127.0.0.1`, serving the registration UI, the live activity feed, and the history/audit browser.

## Data Flow

### One-shot exec

`srv exec <server-id> "<command>" --agent <label>`

1. CLI sends the request to the daemon over the local socket.
2. Daemon resolves `server-id` in the registry, retrieves the secret from Keychain, opens (or reuses a pooled) SSH connection, and runs the command via `exec`.
3. stdout/stderr stream back to the CLI in real time and are simultaneously broadcast over WebSocket to any connected dashboard viewers, tagged with `agentLabel` and `serverId`.
4. On completion, the daemon records the full result (command, output, exit code, timestamps, agent label, server id) to the log store.

### Persistent session

- `srv session start <server-id> --agent <label>` → returns `sessionId`.
- `srv session send <sessionId> "<command>"` — writes to the session's PTY, streams output until idle/prompt heuristic signals completion.
- `srv session stop <sessionId>` — closes the channel explicitly.
- Idle sessions auto-close after a timeout (default 30 min) to avoid orphaned connections.
- Multiple concurrent sessions/execs against the same `server-id` are allowed — no artificial single-session lock, matching SSH's natural multiplexing.

### Security boundary

At no point does the CLI process (or the agent invoking it) receive host, port, username, or secret material — only `server-id`, `sessionId`, command text, and command output. Inspecting the agent's own process environment or CLI history cannot recover the real endpoint.

## Registration

**GUI single-add:** form for id, host, port, user, auth method (password or key path), and the secret value. On save, metadata goes to SQLite and the secret goes straight to Keychain — never persisted to disk in plaintext, never sent back to the browser after save.

**GUI bulk import:** paste a JSON array of the same server-object shape. Daemon validates each entry (required fields, duplicate id detection) and reports per-entry success/failure before committing any of them.

**Edit/delete:** editing updates registry + Keychain; delete purges the Keychain item and blocks new execs/sessions against that id immediately. Already-open sessions/channels at the time of deletion are left alone until they close or hit their idle timeout — not force-killed.

**Keychain ACL:** each Keychain item is created with a trusted-app ACL scoped to the daemon binary, so the daemon can read secrets without triggering a macOS unlock prompt on every access.

## Dashboard

- **Live view:** feed of active execs/sessions grouped by `agentLabel`, showing `serverId` (never host), command, live streaming output, and elapsed time. Observation-only in v1.
- **History/audit view:** every completed exec/session persisted in SQLite (command, output, exit code, agent label, server id, start/end timestamps), browsable and filterable by server or agent, with a default 90-day retention window (configurable).

## Agent Identity

Every CLI invocation must include `--agent <label>` — a caller-supplied string identifying which agent/session issued the command (e.g. `claude-session-refactor`). The dashboard groups and filters by this label. This is a required parameter, not inferred, so labels stay meaningful.

## The Skill

A Claude Code skill documents:
- Both invocation modes (`srv exec` and `srv session start/send/stop`) with examples.
- The requirement to always pass `--agent <label>`.
- That servers are referenced only by `server-id` — agents never need or receive host/credential info.

## Stack

Node.js/TypeScript throughout: `ssh2` for SSH connections, Express + `ws` for the daemon/dashboard HTTP+WebSocket API, `better-sqlite3` for registry and log storage, macOS Keychain access via the `security` CLI or a native binding.

## Visual Direction (Dashboard)

Monochrome brutalist, modeled on Vercel's public Geist design system:

- **Typography:** Geist Sans for UI (600 weight headings, 500 weight nav/labels, 400 weight body), Geist Mono reserved for server IDs, commands, and log/output text — never used for prose.
- **Color:** near-monochrome. True-black page background; status color (green = running, gray = idle, red = error) is the only non-gray accent anywhere in the UI.
- **Backgrounds & elevation:** flat, not layered with solid gray blocks. Only two background levels exist (page background, and a barely-there ~2.5% white tint for cards); separation between page/sidebar/cards/log blocks is done primarily with hairline (~9% white) borders, not background jumps. Hover/active states are translucent white overlays (~6%/9%), not solid fills.
- **Radii:** 6px for small elements (pills, log blocks), 10–12px for cards, 14px for the outer frame — matching Geist's radius presets.
- **Spacing:** generous padding (20–32px in main content areas, 10–16px component-level) — deliberately roomier than a dense terminal, closer to how Vercel's actual dashboard breathes.
- **Layout:** top nav bar (product name + Live/History/Servers/Settings) + left sidebar (server list with status dots, active agent list) + main content area (live activity cards, each showing server id, status, agent label, elapsed time, and an embedded mono-font log excerpt).

Validated interactively via the brainstorming visual companion (mockups in `.superpowers/brainstorm/`, gitignored) against real Awwwards/Geist references before approval:
- [Algorithmic Trading Dashboard](https://www.awwwards.com/sites/algorithmic-trading-dashboard) — considered, not chosen (too raw-terminal).
- [Signal IQ, Setu by Pine Labs](https://www.awwwards.com/inspiration/signaliq-closing-interaction-signal-iq-setu-by-pine-labs) — considered, not chosen (too glow/fintech).
- [Covid-19 Data Dashboard](https://www.awwwards.com/sites/covid-19-data-dashboard) — considered, not chosen (too warm/editorial).
- Vercel's [Geist design system](https://vercel.com/geist/introduction) (colors, typography, materials docs) — **chosen direction**. Note: Geist's public docs describe token architecture and naming but don't publish exact hex/opacity values, so the specific gray/alpha values above are a faithful approximation of their stated system, not lifted verbatim.

## Open Considerations (deferred, not blocking v1)

- Whether to add a dashboard "kill session" control later (cheap to add on top of the observation-only live view).
- Log rotation/retention beyond the default 90-day window if history grows large.
