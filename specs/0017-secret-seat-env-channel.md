---
status: in-progress
created: 2026-10-18
priority: medium
scope: daemon, tmux, seat launch, managed Claude launch, seat env validation
author: ctodie
references: [0013-seat-env-allowlist, 0006-seat-launch-env-filter]
---

# 0017-secret-seat-env-channel

## Overview

Spec 0013 item 9 made the daemon refuse to put any secret-named value on a tmux argv:
- A tmux server keeps the argv of the command that started it, and a client shows its argv while it runs, so `ps` and `pgrep -af` can read it. That is how a value reaches logs and transcripts.
- `createSession` and `respawnPane` refuse a secret-named launch variable (`secret_on_argv_refused`).
- The refusal is today's only control. So a secret-named seat value can't be delivered at all, and the managed Claude launch's `/usr/bin/env -i "NAME=${NAME-}"` forwarding would put any forwarded value on `env`'s argv.

This spec is the channel that delivers such a value to the launched runtime without any argv, and the rule for which sources may carry one. Only the daemon's own environment may:
- the provider-auth allow-list, `recovery.provider_auth_env_allowlist` (empty by default; `startup.ts:593`);
- the runtime provider keys, `runtimeSessionEnv` (`startup.ts:599`).

A rig spec's seat env, a one-off `rig up --env`, and a request's `envOverride` refuse a secret-named name instead (item 4).

This spec doesn't read, store or rotate any credential: values come only from the daemon's environment, as today.

Line numbers below are at cerebral `583fa40e`; the drift section that follows restates what changed by `3d741a89`.

**Drift at `3d741a89` (the upstream v0.7.2 merge).** Three premises above moved; items 1 to 3 are written against the code as it is now.
- **tmux `-e` values no longer ride a client's argv.** `createSession` and `respawnPane` write the whole `new-session`/`respawn-pane` command, `-e NAME=VALUE` included, to a private file and run `tmux source-file <file>` (`runEnvironmentCommand`, `tmux.ts:752`). The merge let daemon-origin secret-named values (the activity token, the provider-auth allow-list) through 0013 item 9's guard on that basis ("option A"). That is channel (a): it keeps the value off argv, but it puts the value in the tmux session environment, where REQ-0017-03 forbids it, and the file is written under `os.tmpdir()` and kept when the command fails.
- **The scoped launch writes every value, secrets included, to a file the pane's own shell sources** (`scopedLaunchCommand`, `tmux.ts:492`), so the pane shell holds the secret, which the Delivery test forbids.
- **The managed Claude launch no longer expands values onto `env`'s argv.** Its command is itself staged by `sendShellCommand`; it forwards a session variable with the builtin `export NAME="${NAME-}"` and ends `exec /usr/bin/env "$@" <claude> …`, where `"$@"` holds only `-u NAME` removals (`claude-managed-launch.ts:307`, `:358`). So item 2's separate file and `/bin/sh -c` wrapper are not needed: the value exported by the staged script (item 1) is the one the forwarding line keeps.

**Where launches go today.**
- **Staged launches:** `sendShellCommandUnchecked` (`tmux.ts:952`) writes nearly every launch (Claude, Codex, the managed launch, Pi when long) to a staged script and sources it in the pane, `( . <script> )` (`:977`).
  - The script is created 0600 with `wx` (O_EXCL), under `os.tmpdir()` with a random name (`:66`, `:1003`).
  - Its first line deletes it by its absolute path (`:1003`). Only the path is on argv.
- **The managed Claude launch** (`claude-managed-launch.ts:175-196`) builds `cd <cwd> && /usr/bin/env -i <assignments> "NAME=${NAME-}" … <claude> <args>`. It forwards session variables by expanding them, so their values are on `env`'s argv while `env` runs.

## Design

### Live probe (private tmux 3.4 socket, a sentinel value, counts only)

**How the probe works.**
- A watcher sampled every process's argv every few milliseconds while each channel ran.
- **Control:** a process carrying the sentinel in its argv was seen: peak 1.
- **A limitation, measured:** today's `-e NAME=VALUE` on a short-lived `new-session` client, with the server already running, was **not** seen. That client lives a few milliseconds, shorter than one scan of `/proc`. So sampling can't prove a transient argv absent. The verification below doesn't rely on it for transient processes.

**The three channels:**

| | argv seen | value in the tmux session env after use | inherited by a new pane in the session | launched process has it |
|---|---|---|---|---|
| (a) `source-file` of a 0600 file of `set-environment` lines, then `respawn-pane` | 0 | yes, until `set-environment -u` | yes | yes |
| (b) the staged launch script exports the value, then execs the runtime | 0 | no (global no) | no | yes; the pane shell doesn't |
| (b2) the managed launch: `env -i <safe> /bin/sh -c '<wrapper>' <file> <runtime>` | 0 | no | no | yes, with only 4 env entries |
| (c) `set-environment` written to a control-mode client's stdin | 0 | yes | (as (a)) | (as (a)) |

- **Same-user readability:** this user can read `/proc/<pid>/environ` of the launched process (`ptrace_scope=1` doesn't block that read).

**Choice: (b) for staged launches and (b2) for the managed launch.**
- In both, the value goes only to the process the launch starts. It never enters tmux's session or global environment, and by construction it is never an argument of any exec:
  - the daemon writes it with a file write (no process);
  - the pane's shell reads it with the `.` builtin (no exec), and `export` is a builtin too.
- (a) and (c) also keep the value off argv. But they leave it in the tmux session environment:
  - `show-environment` shows it to any same-user tmux client;
  - every new pane or window in that session inherits it (probe: a new split had it).
  - Unsetting it afterwards narrows the window but doesn't close it, and (a) also needs a pane respawn.

**Argv is not the only channel** (review r2). A staged script is sourced by the pane's own interactive shell, so it inherits that shell's tracing (item 1). And a value written into a rig spec is stored before any launch (item 4).

### 1. Staged launches carry the value in their staged script

- When a launch has secret-named values, `sendShellCommand` writes them into the staged script as `export NAME='<value>'` lines, single-quoted with `'\''` escaping. They come after the allow-list scrub prologue (0013 item 5), which therefore never sees them as survivors, and before the command.
- **Tracing is off before anything else.** The script's first line is `{ set +xv; } 2>/dev/null`, ahead of the self-delete line, the scrub prologue and the exports.
  - **Why:** the subshell that sources the script inherits the pane shell's options. With xtrace or verbose on (from an rc file, a debugging session or `SHELLOPTS`), the shell prints the `export` line to the pane, so the value reaches the screen, scrollback, transcript capture and `rig capture`.
  - **Review r2's probe** counted sentinel hits on stderr, unguarded vs guarded: bash `set -x` 2 vs 0, bash `set -v` 1 vs 0, zsh `setopt xtrace` 1 vs 0.
  - The script ends by `exec`ing the runtime, so nothing needs restoring.
  - A bash DEBUG trap is not inherited by the subshell unless `functrace` is set; it was not probed.
- **The value appears only on its export line.** Every occurrence of a secret value in a generated script is the single-quoted operand of an `export NAME='…'` line, with no command substitution or external command on that line. No later edit can add an exec that carries it without failing that check.
- Such a launch is always staged, never typed. That includes Pi's short-command path (`stageIfLong`), which types commands of up to 512 bytes today (`tmux.ts:976`).
- **The directory.** The script keeps today's rules: 0600, created exclusively, deleted by its own first lines. It is written in a directory only the daemon's user can list, `<OPENRIG_HOME>/seat-env/launch/`; `os.tmpdir()` is world-listable.
  - The daemon resolves the directory to an absolute path (item 2) and creates it with mode 0700 if absent.
  - It then checks it with `lstat` before each use: a directory, not a symlink, owned by the daemon's uid, mode exactly 0700.
  - Otherwise it refuses the launch, naming the directory and what failed, and writes nothing.
- **tmux never carries the value.** `createSession` and `respawnPane` take the daemon-origin secret-named values out of the env they give tmux, before the `-e` list, the private source-file config and the scoped launch file are built, so none of the three holds them. The adapter keeps them in the daemon's memory, keyed by the session (and by the respawned pane's session), for that session's staged launches; they are the daemon's own values, which its environment already holds. 0013 item 9's guard stays, as a backstop: it still refuses seat env, `envOverride` and a seat value that overrides a daemon value (anything that is not daemon-origin) before any tmux command runs.
- **Fail closed without a directory.** A launch that would carry held values, on an adapter with no secret-bearing directory configured, is refused before anything is written or sent (`secret_channel_unavailable`), naming the variables only.
- **Not yet carried after a daemon restart.** The held values live in the daemon's memory. A seat launched by an earlier daemon life and relaunched in place (resume, restart-in-place) after a restart gets no held value: it is not leaked, it is missing, and the activity relay falls back to `activity-endpoint.json`. Resolving held values from the seat's runtime on demand is a follow-up.
- Every launch that should have the value gets it from its own staged script: fresh launch, resume, handover successor, restart-in-place. A pane shell started by `respawn-pane` without a launch has none.

### 2. The managed Claude launch takes the value from its staged script

- The managed launch never puts a secret-named value on any argv. At `3d741a89` it doesn't: it is staged by `sendShellCommand`, forwards a session variable with the builtin `export NAME="${NAME-}"`, and execs `/usr/bin/env` with only `-u NAME` removals (drift, above).
- So its secret-named values come from item 1: the staged script exports them before the managed command, the forwarding line keeps the exported value, and the `env -u` reduction keeps the name (it is in `selectedKeys`). No second file and no `/bin/sh -c` wrapper.
- The earlier design (a second 0600 file, opened on descriptor 3 and unlinked before `.` reads it) is kept below as the fallback if the managed launch ever forwards by expansion again.
  - `cd <cwd> && /usr/bin/env -i <non-secret assignments and forwards> /bin/sh -c 'exec 3<"$0" || exit 1; rm -f -- "$0"; . /dev/fd/3; s=$?; exec 3<&-; [ "$s" -eq 0 ] && exec "$@"' <file> <claude> <args>`, with an absolute file path (POSIX `.` searches `PATH` for a name with no `/`, and a configured `OPENRIG_HOME` may be relative).
  - Unlink before read, because under dash an error in the special builtin `.` exits the shell before a later `rm` runs.

### 3. Lifetime and cleanup

- **Owner and mode:** the daemon's user; files 0600, directory 0700, checked as in item 1.
- **Deleted before it is read:** the staged script's second line deletes it by its absolute path, before any export line runs. The daemon's cleanup (below, REQ-0017-07) stays the backstop for a launch that never opened its file.
- **The daemon deletes any file still present:**
  - when the launch's send fails;
  - before the next launch to the same seat is staged, and when the seat's session is killed (a launch whose shell never ran its script; readiness reports such a launch as `launch_not_executed` while the file is there, so the file is not removed while it can still be consumed);
  - at startup, **every** file in the directory, before the daemon serves. No launch can own a file then, so none is spared. A file left by a crash minutes before a restart is otherwise never deleted: the other two triggers belong to launches the new daemon never sees.
- **Never logged:** a value is never logged, put in an event, a result or a database row. Failures name the variable only (0013 item 8).

### 4. Only the daemon's environment may carry a secret

**The ruling:** a secret-named value enters a seat only from the daemon's own environment, through the provider-auth allow-list and `runtimeSessionEnv`. Every other seat env source refuses a secret-named name when it is validated, before anything is stored or launched:
- a rig spec's `env:` at rig and member level (`rigspec-schema.ts:185`, `:535`, through `validateSeatEnv`, `seat-env.ts:25`);
- `rig up --env`, checked by the CLI before it sends (`cli/src/commands/up.ts:114-135`);
- a request's `envOverride` on `/api/up` and `/api/bundles/install` (`routes/up.ts:218`, `routes/bundles.ts:1128`, through `readSeatEnvOverride`, `seat-env.ts:55`). Today a malformed `envOverride` is ignored rather than refused; a secret-named name is refused instead, and other malformed values keep today's answer.

**Why these sources:**
- **Storage:** a rig spec's seat env is stored in plaintext: `rig.yaml`, `rigs.env_json` and `nodes.env_json`, and every backup that copies the database, where a value persists after it is removed from the spec.
- **Exposure:** `rig up --env NAME=VALUE` isn't saved (a later restore uses the spec's `env:`), but it puts the value on the CLI's own argv and in the shell's history before the daemon sees it. An `envOverride` carries the same value in the request.
- A channel that keeps values off tmux argv doesn't help once the value is on disk upstream.
- `seat-env.ts`'s header already says seat env is for non-secret settings only. A runtime change already refuses a secret-named `--to-env` (`runtime_change_secret_env`, `seat-handover-service.ts:1339-1343`).

**The refusal:**
- Same name rule as 0013 item 9: `SEAT_ENV_SECRET_NAME` (`seat-launch-env-filter.ts:46`).
- Same style as `runtime_change_secret_env`. It names the variable and the source, never the value, and gives a remedy: provide credentials through the provider-auth allow-list, not seat env.
- **`rig up --env` can't undo the exposure.** By the time the CLI refuses, the value is on its argv and in the shell's history. Its refusal says so: the value was already exposed on the command line and in the shell history, so rotate it if it was a real credential (review r2's L3).
- The validation error's code is `seat_env_secret_name`.

**One exemption list, exact names.**
- **The problem:** the name rule matches substrings, so some harmless settings match it (`TOKENIZERS_PARALLELISM` contains `TOKEN`).
- **The list:** one list of exact names, in code next to the rule. Each entry has a one-line reason, and adding a name takes a PR. No patterns.
- **One source for the rule and the list.** The daemon's `seat-launch-env-filter.ts` exports both, with one function that answers "is this name secret-named and not exempt". Every check uses it, so an exempt name is refused nowhere. Today the rule has four copies (at `583fa40e`):
  - `seat-launch-env-filter.ts:46`, the exported `SEAT_ENV_SECRET_NAME`, used by 0013 item 9's launch guard (`secretNamedLaunchVars`, `tmux.ts:79-83`): **stays**, as the single source;
  - `seat-handover-service.ts:172`, `SECRET_ENV_NAME`, the runtime-change refusal (`runtime_change_secret_env`): **goes**, it imports the source;
  - `user-settings/settings-store.ts:787`, the `seat_env.base` check: **goes**, it imports the source;
  - `cli/src/config-store.ts:926`, the CLI's `seat_env.base` check: **goes**. The CLI imports the source through a new daemon subpath export, as it already imports `@openrig/daemon/daemon-shutdown`; the CLI's `rig up --env` check uses the same import.
  - The seat env validation above uses it too.
- **It starts with one entry:** `TOKENIZERS_PARALLELISM` (a tokenizer library's thread setting; the case review r2 probed). A name joins only when someone needs it.
- **`OPENRIG_SEAT_ENV_KEYS` is not on the list.** It stays exempt under item 9's own rule, by its value's shape: a comma-separated list of names.

**Stored env that already holds a secret-named name.**
- In the deployment this spec was written for, no rig or node stored any seat env (0 `env_json` rows, read 2026-10-18). So no stored value is known to exist.
- For any that does: at its next launch, restore or `rig up`, the stored name is refused with the same code before anything launches. The remedy names the rig spec field to remove and says to relaunch.
- The refusal doesn't delete what is stored, in the database or in earlier backups. Clearing stored copies is the operator's call.

### 5. What a same-user process can still read (stated, not changed)

Values never reach any argv, and tracing is off while they are exported, so `ps`, `pgrep -af`, process listings, the pane, logs and transcripts don't carry them. A process running as the daemon's own user can still read:
- the file during its short life;
- the launched runtime's `/proc/<pid>/environ` for the runtime's life.

Separating those is the seat-user plan's job (each seat as its own unix user), not this channel's.

### 6. Not in scope

- Rotation, OpenBao, and any credential read or store.
- Which daemon-env sources are switched on: the provider-auth allow-list stays empty by default.
- The seat-user plan.
- Deleting values already copied into database backups.

## Requirements

- REQ-0017-01: The daemon shall not pass a secret-named seat value as an argument to any process, including tmux clients, the tmux server, `env`, `sh` and `rm`.
- REQ-0017-02: When a launch has secret-named values, the tmux adapter shall stage the launch and write the values as exports in its staged script, after any scrub prologue.
- REQ-0017-03: The tmux adapter shall not put a secret-named value in a tmux session or global environment.
- REQ-0017-04: When a managed Claude launch has secret-named values, it shall take them from its staged script's exports.
- REQ-0017-05: The daemon shall write a secret-bearing file with mode 0600, created exclusively, in a directory with mode 0700.
- REQ-0017-06: The launch's shell shall delete a secret-bearing file before it reads any exported value from it.
- REQ-0017-07: If a secret-bearing file outlives its launch, then the daemon shall delete it.
- REQ-0017-08: When a launch is refused or fails, the daemon shall name a secret-named variable without its value.
- REQ-0017-09: The tmux adapter shall make `{ set +xv; } 2>/dev/null` the first line of every staged script that carries a secret-named value.
- REQ-0017-10: The daemon shall write a secret-named value only as the single-quoted operand of an `export` line, with no command substitution or external command on that line.
- REQ-0017-11: If the secret-bearing directory is not a directory owned by the daemon's uid with mode 0700, or is a symlink, then the daemon shall refuse the launch and write nothing.
- REQ-0017-12: When the daemon starts, it shall delete every file in the secret-bearing directory before it serves requests.
- REQ-0017-13: If a rig spec's seat env, a `rig up --env` or an `envOverride` names a secret-named variable that is not on the exemption list, then validation shall refuse it with `seat_env_secret_name`, naming the variable and not its value.
- REQ-0017-14: The seat env validation, the tmux launch guard, the runtime change refusal and both `seat_env.base` checks shall take the name rule and the exemption list from one daemon export.
- REQ-0017-15: If a stored seat env names a secret-named variable that is not on the exemption list, then the next launch, restore or `rig up` of that seat shall refuse with `seat_env_secret_name` before launching, and name the spec field to remove.
- REQ-0017-16: When `createSession` or `respawnPane` is given daemon-origin secret-named values, the tmux adapter shall leave them out of the `-e` list, the private source-file config and the scoped launch file, and hold them for that session's staged launches.
- REQ-0017-17: If a launch would carry held secret-named values and no secret-bearing directory is configured, then the tmux adapter shall refuse the launch with `secret_channel_unavailable` before it writes or sends anything, naming the variables and not their values.
- REQ-0017-18: When a managed Claude launch has secret-named values, it shall not pass any of them as an argument to a process it starts.

## Plan

1. This spec, reviewed for security before any code.
2. One fork PR: the channel (items 1 to 3) and the source rule (item 4), with 0013 item 9's guard kept as a backstop.
3. Switching any daemon-env source on is a separate, operator-gated step.

## Test

**Red first, on a real tmux 3.4 server, with sentinel values:**
- **Persistent processes:**
  - Start a server and a seat the way the daemon does, launching with a secret-named value through each path: staged, and managed.
  - Scan the argv of every process in the seat's tree and of the tmux server for the sentinel: 0. On Linux read `/proc/*/cmdline`; on macOS, which has no `/proc`, read `ps -ww -o args`. The scanner's own positive control is a long-lived process holding the sentinel in its argv (seen: at least 1), so a scanner that can't see argv fails instead of passing.
  - Target tmux 3.4 (ceres); the suite runs on whatever tmux the host has and the run reports its version.
  - **Red:** the same scan when the value is passed with `-e`, on a server that command starts: at least 1.
- **Transient processes**, deterministic because sampling can miss them:
  - Record every argv the tmux adapter executes (the adapter's exec function), the staged script's command line, and the managed command text.
  - None holds the sentinel, and only the file path appears.
  - **Red:** the same recording with today's `-e` or `"NAME=${NAME-}"` forwarding holds it.
- **The export-line rule:** every occurrence of the sentinel in the generated script and the managed file is on an `export NAME='…'` line with nothing else on it. **Red:** a generated line that puts the value in a command substitution.
- **Tracing (R1):**
  - Source the generated staged script under bash `-x`, bash `-v` and zsh with `xtrace`, and count the sentinel on stderr: 0.
  - **Red:** the same script without the guard line: at least 1 under each.
- **Residency:**
  - After the launch, read only the named variable: `show-environment -t <session> NAME` and `show-environment -g NAME`. An unnamed listing prints every variable in that environment, including any secret the server inherited.
  - Neither holds the sentinel.
  - **Red:** with channel (a), the session environment holds it.
- **Delivery:** the launched runtime's environment has the value; the pane shell's doesn't.
- **Files and the directory:**
  - each file is mode 0600, created exclusively, in a 0700 directory;
  - it is gone after the launch and after a failed send;
  - **unlink before read, under dash:** a managed file whose `.` aborts (a syntax error) is gone when the shell exits, and Claude doesn't start. **Red:** the earlier wrapper (`. "$0"; s=$?; rm -f -- "$0"; …`) with the same file leaves it behind. A missing file exits non-zero (2 under dash) without starting Claude; the test asserts non-zero, not an exact code;
  - a directory that is a symlink, has another mode, or is owned by another uid refuses the launch;
  - every leftover file is removed at startup, including one written seconds before.
- **The managed launch:** a staged script with the value exported, followed by the managed command's forwarding line and `env -u` reduction, delivers the value to the exec'd process, and the command text holds no value.
- **Sources (R2):**
  - `env:` at rig and member level, `rig up --env` and `envOverride` each refuse `GITHUB_TOKEN` with `seat_env_secret_name`, naming it without its value.
  - `TOKENIZERS_PARALLELISM` passes validation, the launch guard, the runtime change and both `seat_env.base` checks.
  - **One source:** the handover, both settings stores and the CLI import the daemon's export; no other copy of the rule exists (a source scan of `packages/*/src` for the rule's literal finds only the export). **Red:** a fifth copy fails the scan.
  - **The `--env` refusal** names the variable, never the value, and says to rotate it.
  - **Red:** before the change, each source accepts `GITHUB_TOKEN`.
- **Stored env:** a node whose stored `env_json` names a secret-named variable is refused at its next launch and at `rig up`, before any tmux command, with the remedy.
- **Break-once:** each rule, broken on purpose, turns its test red.
