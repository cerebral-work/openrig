---
status: in-progress
created: 2026-10-25
priority: high
scope: daemon, claude-code launch, native identity, settings
author: fork-maintainers
references: [CER-3221]
---

# 0020-claude-code-channels

## Overview

Claude Code lets an MCP server push inbound messages into a session ("channels", a research preview). A session opts in at launch. Three facts, read from Claude Code 2.1.310 and tested on it, shape how OpenRig can do this for managed seats.

1. **The development flag cannot launch a seat unattended.**
   - `--dangerously-load-development-channels <entries...>` loads any server, but shows a full-screen confirmation ("WARNING: Loading development channels").
   - It reappeared after being accepted, in the same directory and config, and with `--dangerously-skip-permissions`.
   - Nothing pre-acknowledges it: the bypass warning has `skipDangerousModePermissionPrompt`, and this dialog has no such setting.
2. **`--channels <entries...>` shows no confirmation**, but loads only allowlisted plugin entries (`plugin:<name>@<marketplace>`).
   - A managed policy (`channelsEnabled: true` plus `allowedChannelPlugins`) can admit a plugin.
   - A bare `server:` entry is never admitted.
3. **Native identity proof refuses argv it does not recognise** (`native-process-lineage.ts`: "Unknown argv is not positive identity proof"). A generic "extra launch arguments" setting would quietly remove identity proof from every seat that used it.

## Design

- **The setting:** `runtime.claude_code.channels` (env `OPENRIG_RUNTIME_CLAUDE_CODE_CHANNELS`).
  - Comma-separated `plugin:<name>@<marketplace>` entries; empty by default.
  - Both settings stores validate it in lockstep: `rig config set` refuses an empty item and any other form, so neither a `server:` entry nor a flag can be set.
- **One place for every launch.** `operationalLaunchArgs("claude-code", …)` appends `--channels <entries...>` after the operational flags.
  - Every Claude launch path takes its flags from there: fresh launch, resume and fork in the adapter, and restore.
  - Both forms (managed argv and shell text), and every seat kind: ordinary, kernel, team-default, full-bypass.
  - Other runtimes are unchanged.
- **Read fresh at each launch**, as the compaction policy is, so a change applies at each seat's next launch, resume, fork or restore without a daemon restart.
  - An unreadable or invalid value reads as none. A bad value never stops a seat.
- **The variadic list ends cleanly.** Claude's `--channels` takes several values. Every launch path follows OpenRig's operational flags with another flag (`--model`, `--resume`, `--session-id`, `--name`), so the list ends where OpenRig ends it.
- **Identity proof accepts the option.** Both Claude argv parsers in `native-process-lineage.ts` (identity and delivery) accept `--channels` with one or more values, and `--channels=<entry>`. `--channels` with no value, or any unknown flag, is still no proof.
- **Test isolation:** the hermetic test setup scrubs the env name, so a seat's own setting cannot change the launch commands the suites pin.

## Operator setup (outside OpenRig)

1. Install the channel plugin in the Claude config the seats use.
2. Add a managed-settings file that sets `channelsEnabled: true` and lists the plugin in `allowedChannelPlugins`. On that machine this replaces Anthropic's default channel allowlist.
3. `rig config set runtime.claude_code.channels plugin:<name>@<marketplace>`.

## Verification

- **`claude-channels.test.ts`:**
  - 4 launch paths × 4 seat kinds: the option appears exactly once, and the command is byte-identical when unset;
  - invalid values read as none;
  - the argv form; other runtimes untouched;
  - identity read from a command line carrying the option.
- **`native-process-lineage.test.ts`:** identity and delivery proof beside `--channels`, in the space, `=` and multi-entry forms. No value, or an unknown flag beside it, is still no proof.
- **Settings stores on both sides:** default, set, refusals. The settings route count rises to 91.
- **Break-once:**
  - removing the identity parser's handling: 3 failures;
  - removing the append: 17 failures;
  - a CLI validator that accepts `server:`: 1 failure.
- **Live proof before any rollout:** one unattended seat launch with the setting reaches ready, with no prompt in its pane.

## Out of scope

- The `resumeCommand` hint in `rig ps` and `rig ask --wake` (`claude -p`, where Claude ignores channels) do not launch seats.
- The development-channels flag is not supported, for the reason above.
