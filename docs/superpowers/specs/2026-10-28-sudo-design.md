# Daemon-fed sudo for `srv` — Design

## Purpose

Let an agent run a command as root on a registered server, through `srv`, without the human first editing the box's sudoers (and without anyone having to remember to undo that edit afterwards), and without the agent ever learning the sudo password.

Today `srv exec` closes the remote stdin immediately, so `sudo` reads EOF and fails. `srv session` opens a PTY, so `sudo` prompts, but the agent cannot answer because by design it never sees any credential. The workaround has been a standing `NOPASSWD` rule on the box, which is exactly the kind of state that outlives the task it was created for.

## Intent

The daemon already holds each server's login password in the macOS Keychain. On most boxes that is the password `sudo` wants. So the secret already lives in the right place; the only missing piece is a daemon-side path that feeds it to `sudo` over the (already encrypted) SSH channel. No file is written on the remote machine. There is nothing to clean up.

Sudo is **off per server by default** and turned on explicitly by the human in the dashboard. Once a server has it on, an agent passing `--sudo` is honoured without further prompting ("per-server auto", the user's choice over per-request approval).

## Goals

- `srv exec --sudo`, `srv exec-many --sudo` and `srv session start --sudo` work on servers where the human has enabled sudo.
- The sudo password never appears in: the CLI process, the command string (remote `ps`, shell history), the audit log's `command` or `output` columns, dashboard broadcasts, or the daemon's stderr.
- Servers whose sudo password differs from the login password (key-based auth, `targetpw`/`rootpw` boxes) can store a separate sudo password in Keychain.
- Every sudo run is marked as such in the audit log and the dashboard, including refused attempts.
- Nothing is written to the remote box's sudoers, ever.

## Non-goals

- Per-request human approval in the dashboard. Rejected for now by the user in favour of a per-server switch; the audit trail is the control.
- Command allowlists or any policy on *what* may run as root. Consistent with the v1 design: full shell access once connected, relying on visibility.
- Managing `/etc/sudoers.d` on the remote box, even temporarily. Needs sudo to create it, and if the daemon dies mid-run the rule outlives it. Strictly worse than feeding `sudo` directly.
- `su`, `doas`, or PAM/ssh-agent based privilege elevation.
- Boxes with `Defaults requiretty` in sudoers (old RHEL). `exec --sudo` will fail there with sudo's own "a terminal is required" message; this is documented, not worked around (see Open to the builder).

## Anti-goals

Things that would make this a failure even if it technically works:

- The sudo password reaching any client-facing field, log row, or broadcast, even once, even on an error path.
- The password being handed to the *command* instead of to `sudo` (see "Leak hazard" below), which would print it into the run's output and the audit log.
- An agent being able to run as root on a server where the human never switched sudo on.
- Editing a server in the dashboard silently dropping its sudo setting or sudo password (same class of bug the reachability columns had; `registry.upsert` lists columns explicitly for this reason).

## Constraints

- Follows the existing boundaries: the CLI stays credential-free; secrets live only in Keychain; SSH errors go through `sanitizeSshError`; the private-key path restriction is untouched.
- Additive SQLite migrations only, same `PRAGMA table_info` pattern as the existing columns.
- Test doubles follow the existing pattern: real `Registry`/`LogStore` against temp SQLite files, fake `connectFn` and fake Keychain `exec`.
- Frontend remains vanilla JS/CSS with no build step; follow the Innovative VAS tokens and the list/detail rendering rules in `CLAUDE.md`.

## Design

### 1. Registry: a per-server switch

- New column `sudo_allowed INTEGER NOT NULL DEFAULT 0` on `servers`, added by the additive-migration pattern.
- `ServerRecord` gains `sudoAllowed?: boolean` (absent/false means off).
- `upsert` writes it explicitly alongside the other columns. Editing a server with the field omitted keeps the stored value (same contract as `last_test_*`); a test covers this.

### 2. Keychain: an optional second secret per server

- A second generic-password entry under the same service, account `<serverId>:sudo`. `Keychain` gains `setSudoSecret`, `getSudoSecret` (throws when absent, like `getSecret`) and `deleteSudoSecret`. Deleting a server deletes both entries.
- **Whether a sudo secret is stored is persisted in the registry**, as `sudo_secret_stored INTEGER NOT NULL DEFAULT 0`, written in the same step that writes the Keychain entry. The dashboard reads this column (as `hasSudoSecret`), never Keychain: a live `security find-generic-password` per server on every list fetch would be one subprocess per server per refresh with 50+ servers, and one Keychain access prompt per server in dev mode (`tsx`), where the daemon's path is not the ACL-trusted one. The daemon's own sudo-password resolution still asks Keychain directly, so a stale flag can only mis-render a hint, never grant or deny sudo.
- **Removing a stored sudo secret.** Turning the "Allow sudo" toggle off deletes the `:sudo` entry and clears the flag; switching it back on later asks for that password again. The login secret (account `<serverId>`) is never touched by the toggle, so ordinary `exec` and sessions keep working. For a password-auth server that reuses its login password for sudo there is no `:sudo` entry at all, so toggling off deletes nothing and toggling on needs no re-entry. Keeping a stale password behind an off switch would be exactly the silent state this feature exists to avoid. While the toggle is on, the edit form offers a "use login password instead" action (password-auth servers only) that sends `sudoSecret: null`; the API treats `null` as "delete the entry", absent as "keep", and a string as "replace". The rollback path on a failed write restores whichever of the two entries it changed.
- **Sudo password resolution**, in the daemon only:
  1. If a `<serverId>:sudo` entry exists, use it.
  2. Else if `authMethod === 'password'`, use the login secret.
  3. Else fail the request with `sudo error: no sudo password stored for <id>` before any SSH connection is made.
- Why a separate entry rather than always reusing the login password: key-auth servers have no password in Keychain (only an optional passphrase), and `targetpw`/`rootpw` boxes want a different password than the login one.

### 3. Protocol and CLI

- `ExecRequest` and `SessionStartRequest` gain `sudo?: boolean`.
- `srv exec`, `srv exec-many` and `srv session start` gain a `--sudo` flag that sets it. `exec-many` applies it per server; a server with sudo off fails that server's run and the others proceed, consistent with the per-server timeout/retry budgets.
- The daemon refuses `sudo: true` on a server with `sudoAllowed` off with `done` error `sudo is not enabled for <id>`, without connecting. The refusal is still recorded in the audit log (see §6).

### 4. `exec --sudo`: feed the password over stdin

In `SshManager.exec`, when a sudo password is supplied, the command sent to the remote is rewritten as:

```
sudo -S -k -p '' -- sh -c 'exec </dev/null; <command, single-quote escaped>'
```

and instead of ending the channel immediately after `exec`, the daemon writes `<password>\n` to the channel, then ends it. Each flag is load-bearing:

- `-S` makes sudo read the password from stdin instead of a tty.
- `-p ''` sets an empty prompt so sudo prints nothing to stderr before reading it.
- `-k` makes sudo ignore any cached timestamp for this invocation, so it always *tries* to read the password line. Without it, a cached credential would leave the password line unread in the pipe.
- `--` ends sudo's own option parsing.
- `exec </dev/null` inside the `sh -c` is the **leak guard** (see below). It also preserves the existing documented behaviour that an `exec` command sees immediate EOF on stdin.

**Leak hazard this design must defeat.** `sudo -S` only consumes the stdin line when it actually needs to prompt. If the box already grants `NOPASSWD` (or some other path skips the prompt), the password line would otherwise flow straight into the command's stdin: `srv exec --sudo "cat"` would print the password into the run's output and the audit log. Redirecting the command's stdin from `/dev/null` before it runs means the unread line is simply discarded when the channel closes. The unit test for the wrapper asserts both the `-k` flag and the `exec </dev/null;` prefix are present in the exact command string handed to `client.exec`, and that the password appears in the stdin writes but never in the command string.

The command runs under root's `sh`, not the login user's `$SHELL`. Acceptable; documented in the skill.

Sudo's own failure messages (`Sorry, try again.`, `sudo: 1 incorrect password attempt`, `sudo: a terminal is required to read the password`) carry no host information and are passed through on stderr with sudo's exit code, unmodified. The agent sees the real reason; nothing extra is mapped.

### 5. `session start --sudo`: prime sudo's own cache

Sessions are PTYs, so a different mechanism applies. `sudo -S` must **not** be used here: with a pty on stdin and `-S`, sudo does not turn echo off, and the password would be echoed into the output stream and the audit log.

Instead the daemon primes sudo's timestamp cache right after the shell opens, using sudo's normal tty prompt (which disables echo itself):

1. Write to the shell: `sudo -k; sudo -p '<PROMPT_SENTINEL>' -v; echo <DONE_SENTINEL>$?` followed by newline. The sentinels are random per session (e.g. `__srv_sudo_<uuid>__`), so a command cannot forge them.
   **The PTY echoes that command line back before sudo prints anything**, so the sentinels must never appear contiguously in the text the daemon writes. Both are split with shell quote concatenation in the command text, e.g. `-p '__srv_sudo''_<uuid>__'` and `echo '__srv_done''_<uuid>__'$?`: the echo contains the broken form, while sudo and `echo` print the joined token. A literal implementation that fires on the echoed line would write the password before sudo has decided whether to prompt, which defeats the leak guard in exactly the NOPASSWD case it exists for. The unit test feeds the echoed command line back through the fake channel and asserts the password is not written in response to it.
2. Watch the output stream. **Only when the joined `<PROMPT_SENTINEL>` is observed** does the daemon write `<password>\n`. If the joined `<DONE_SENTINEL>` arrives first (NOPASSWD, or a cached credential surviving `-k`), the password is never sent. This is the session-mode version of the leak guard: a password line written to a shell that was not prompting would be *executed as a command* and echoed.
3. `<DONE_SENTINEL>0` means primed; any other code fails the `session_start` request with `sudo error: authentication failed`, and the session is closed. A 15 s timeout with no sentinel fails the same way.
4. Output produced during priming is neither streamed to the client nor appended to the run's output; the daemon streams from the first byte after `<DONE_SENTINEL>…\n`.

After priming, every `sudo <cmd>` the agent sends in that session runs without a prompt for the box's `timestamp_timeout` window (5 to 15 minutes by default), which is sudo's own self-expiring mechanism and the closest thing to the "temporary passwordless session" the user asked for. On `session_stop` and on the 30-minute idle timeout, the daemon writes `sudo -k\n` best-effort before ending the channel, so the cache does not outlive the session.

Caveats, documented in the skill: boxes with `timestamp_timeout=0` disable the cache, so `sudo` prompts again on the next command and that command will hang until the per-send idle detection returns; the agent should use `exec --sudo` on such boxes.

### 6. Audit log and dashboard

- `runs` gains `sudo INTEGER NOT NULL DEFAULT 0` (additive migration). `RunRecord` and `RunSummary` gain `sudo: boolean`. `LogStore.start` takes it.
- A refused sudo attempt (switch off, or no sudo password resolvable) is recorded as a run with `sudo: true`, the attempted command, output set to the refusal message, and `exitCode: null`, so the history shows who tried what.
- Broadcast events for sudo runs carry `sudo: true`; the dashboard's live view and history rows show a small `sudo` chip (Sunbird, sparingly, matching the tab-underline usage) next to the command. The detail pane shows it too.
- Server form: an "Allow sudo" toggle (off by default) and, when on, a "Sudo password" field. Placeholder reads "same as login password" for password-auth servers; for key-auth servers the field is required on create, and on edit may be left blank to keep the stored one (mirrors the existing secret-on-edit rule). When a stored sudo secret exists on a password-auth server, a "use login password instead" action clears it (§2). `GET /api/servers` returns `sudoAllowed` and `hasSudoSecret` (from the registry column), never the secret. Bulk JSON accepts `sudoAllowed` and `sudoSecret` per entry.
- `POST /api/servers` and `/bulk` keep their rollback-safe write ordering: the sudo secret is written in the same Keychain step as the login secret, and a failure restores both prior entries.

### 7. Skill doc

`srv-wrapper/SKILL.md` documents `--sudo` on all three commands, that it only works on servers where the human has enabled it, that `exec --sudo` runs the command under root's `sh` with stdin from `/dev/null`, the `requiretty` and `timestamp_timeout=0` caveats, and that the agent should ask the human to enable sudo on a server rather than attempt a workaround.

## Open to the builder

- Exact Keychain account naming and whether `Keychain` grows a `kind` parameter or separate methods; either is fine as long as the two entries are independent and both are removed on delete.
- Shell-quoting helper for the `sh -c` argument (single-quote with `'\''` escaping is the obvious choice).
- Whether `exec --sudo` should request a PTY on the exec channel to support `requiretty` boxes. Not required; if attempted, it must keep the leak guard and must confirm sudo disables echo on that pty before the password is written.
- Sentinel format and the priming-phase output suppression mechanics in `startSession`.
- Dashboard layout for the toggle and field inside the existing edit card.

## Testing expectations

- `ssh-manager`: wrapper string shape (flags, `exec </dev/null;`, quoting), password written to stdin then channel ended, password absent from the command string, non-sudo path unchanged. Session priming: password written only after the prompt sentinel; never written when the done sentinel arrives first; failure code closes the session; priming output not forwarded.
- `registry`: `sudo_allowed` and `sudo_secret_stored` persist through an edit that omits them; migration on a pre-existing database.
- `keychain`: both entries set, read, and deleted independently.
- `socket-server`: refusal without connection when the switch is off; refusal recorded in the log; sudo flag reaches `LogStore.start` and broadcasts; resolution order of the sudo password (separate entry, then login password, then error).
- `logstore`: `sudo` column migration and round-trip in `get`/`list`.
- `dashboard-server`: `sudoAllowed`/`hasSudoSecret` in `GET`, secret never returned, rollback on Keychain failure restores both entries; toggle off deletes the `:sudo` entry and clears the flag; `sudoSecret: null` deletes, absent keeps, string replaces.
