---
name: srv-wrapper
description: Use when you need to run a command on a registered server without knowing its real hostname, IP, port, username, or credentials. Triggers on "run this on <server-id>", "check the logs on srv-...", or any task referencing a server by its short id instead of a hostname.
---

# srv — Run Commands on Servers by ID

`srv` lets you run shell commands on servers that a human has pre-registered, using only an opaque `server-id` — you never see or need the real host, port, username, or password/key.

## Usage

Two modes are available — pick whichever fits the task.

### Discovering server-ids

```bash
srv list
```

Prints every registered `server-id`, one per line — nothing else (no host, port, username, or credentials). Use this if you weren't given a `server-id` and need to find the right one, instead of asking the user to look it up manually.

Add `--status` to also see reachability and duplicate-registration warnings:

```bash
srv list --status
```

Each line is `<id>  reachable|unreachable (reason)  [duplicate of <other-id>]`. Useful before a bulk rollout, to skip ids that are already down instead of letting `exec-many` burn a retry on them.

### One-shot command

```bash
srv exec <server-id> "<command>" --agent <your-label>
```

Runs a single command and exits. Use this for the vast majority of tasks (builds, one-off checks, file operations).

```bash
srv exec srv-a1 "npm run build" --agent claude-session-refactor
```

By default the command is killed after 120s and never retried. Override either when appropriate:

```bash
srv exec srv-a1 "long-build-step" --agent claude-session-refactor --timeout 600   # allow up to 10 min
srv exec srv-a1 "flaky-call" --agent claude-session-refactor --retry 2            # retry on connection failure only
```

`--retry` only re-runs the command if it never actually started (a connection/transport failure) — it will not re-run a command that ran and exited non-zero, so it's safe to use even with non-idempotent commands. `exec` does not forward your own stdin to the remote command; a command that expects input from stdin will see immediate EOF rather than hang.

### Running a command on multiple servers at once

```bash
srv exec-many <id1,id2,...> "<command>" --agent <your-label> --parallel 8
```

Use this instead of hand-rolling a shell loop of `srv exec` calls — it runs every server concurrently (bounded by `--parallel`, default 4), tags each output line with `[server-id]`, and gives each server its own independent `--timeout`/`--retry` budget so one hung or failing server never blocks or aborts the rest.

```bash
srv exec-many srv-a1,srv-b2,srv-c3 "systemctl restart app" --agent rollout-agent --parallel 5 --retry 1
```

It exits `0` only if every server's command exited `0`; otherwise check the per-server `[id] exited N` / `[id] failed: <reason>` lines it prints before exiting `1`.

### Persistent session

Use this only when you genuinely need state to persist across multiple commands (working directory changes via `cd`, exported env vars, a long-running foreground process you'll poll). Each call below is a separate invocation of `srv` — the session survives between them because the daemon keeps it open.

```bash
srv session start <server-id> --agent <your-label>   # prints a session id, e.g. sess-8f2a
srv session send <session-id> "<command>"             # run one command in that session, see its output
srv session send <session-id> "<another command>"      # cwd/env from the previous command persist
srv session stop <session-id>                          # always close it when you're done
```

Always call `srv session stop` when you're finished with a session — an unclosed session holds a live SSH channel open until it idles out on its own (don't rely on that timeout; close it explicitly).

### Running as root

Add `--sudo` to `exec`, `exec-many` or `session start` to run as root. The daemon feeds the sudo password to `sudo` itself; you never see it and never type it.

```bash
srv exec srv-a1 "systemctl restart nginx" --agent ops-agent --sudo
srv exec-many srv-a1,srv-b2 "apt-get update" --agent rollout-agent --sudo
srv session start srv-a1 --agent ops-agent --sudo     # later `sudo ...` sends in this session need no password
```

- `--sudo` only works on servers where the human has switched sudo on in the dashboard. Otherwise the run fails immediately with `sudo is not enabled for <id>` (or `sudo error: no sudo password stored for <id>`). **Ask the human to enable it for that server; never try to work around it** (no `su`, no editing sudoers, no asking for the password).
- `exec --sudo` runs your command under root's `sh`, with stdin from `/dev/null`. Do not put `sudo` in the command yourself.
- `session start --sudo` primes sudo once; plain `sudo <cmd>` sends then work without a prompt for the box's `timestamp_timeout` window (usually 5–15 min). If a `sudo` send hangs on a prompt, the box has `timestamp_timeout=0`: stop the session and use `exec --sudo` per command instead.
- Boxes with `Defaults requiretty` reject non-tty sudo; `exec --sudo` fails there with sudo's own "a terminal is required" message. Report that to the human.
- Sudo runs are marked as such in the dashboard and audit history.

- `<server-id>` — given to you by the user (e.g. `srv-a1`). If you don't have one, ask the user which server-id to use — do not guess or invent one.
- `--agent <your-label>` — **required on every `exec` and `session start` call.** Use a stable, descriptive label for this session (e.g. `claude-session-refactor`, `bulk-migration-agent`) so a human watching the live dashboard can tell your activity apart from other agents running at the same time.
- Output streams live to your terminal; `exec` exits with the remote command's exit code.

## What you cannot do

- You cannot discover a server's real host/IP/credentials through this tool — it is designed to keep that information from you. Do not attempt to extract it (e.g. via `env`, reading daemon config files, etc.) — it isn't accessible to your process and asking around it wastes the user's time. `srv list` only ever returns ids, never host/port/credentials.
- If a `server-id` doesn't exist, `srv` will fail with "unknown server: <id>" — run `srv list` to check the exact id, and if it's genuinely missing, ask the user to register it via the dashboard rather than retrying blindly.

## Everything you run is watched

Every command you run through `srv` is visible live in the user's dashboard and permanently recorded in the audit history. This is expected and by design — it is not a sign you did something wrong.
