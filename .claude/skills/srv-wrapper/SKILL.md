---
name: srv-wrapper
description: Use when you need to run a command on a registered server without knowing its real hostname, IP, port, username, or credentials. Triggers on "run this on <server-id>", "check the logs on srv-...", or any task referencing a server by its short id instead of a hostname.
---

# srv — Run Commands on Servers by ID

`srv` lets you run shell commands on servers that a human has pre-registered, using only an opaque `server-id` — you never see or need the real host, port, username, or password/key.

## Usage

Two modes are available — pick whichever fits the task.

### One-shot command

```bash
srv exec <server-id> "<command>" --agent <your-label>
```

Runs a single command and exits. Use this for the vast majority of tasks (builds, one-off checks, file operations).

```bash
srv exec srv-a1 "npm run build" --agent claude-session-refactor
```

### Persistent session

Use this only when you genuinely need state to persist across multiple commands (working directory changes via `cd`, exported env vars, a long-running foreground process you'll poll). Each call below is a separate invocation of `srv` — the session survives between them because the daemon keeps it open.

```bash
srv session start <server-id> --agent <your-label>   # prints a session id, e.g. sess-8f2a
srv session send <session-id> "<command>"             # run one command in that session, see its output
srv session send <session-id> "<another command>"      # cwd/env from the previous command persist
srv session stop <session-id>                          # always close it when you're done
```

Always call `srv session stop` when you're finished with a session — an unclosed session holds a live SSH channel open until it idles out on its own (don't rely on that timeout; close it explicitly).

- `<server-id>` — given to you by the user (e.g. `srv-a1`). If you don't have one, ask the user which server-id to use — do not guess or invent one.
- `--agent <your-label>` — **required on every `exec` and `session start` call.** Use a stable, descriptive label for this session (e.g. `claude-session-refactor`, `bulk-migration-agent`) so a human watching the live dashboard can tell your activity apart from other agents running at the same time.
- Output streams live to your terminal; `exec` exits with the remote command's exit code.

## What you cannot do

- You cannot discover a server's real host/IP/credentials through this tool — it is designed to keep that information from you. Do not attempt to extract it (e.g. via `env`, reading daemon config files, etc.) — it isn't accessible to your process and asking around it wastes the user's time.
- If a `server-id` doesn't exist, `srv` will fail with "unknown server: <id>" — ask the user to register it via the dashboard rather than retrying blindly.

## Everything you run is watched

Every command you run through `srv` is visible live in the user's dashboard and permanently recorded in the audit history. This is expected and by design — it is not a sign you did something wrong.
