---
status: in-progress
created: 2026-11-09
priority: high
scope: daemon, agy runtime adapter, agy resume
author: ctodie
references: [funnel-critic@leads, funnel-researcher@leads]
---

# 0022-agy-exec-launch-and-screen-first-readiness

## Overview

On Debian and Ubuntu, `/bin/sh` is dash. The staged launch script runs `cd <cwd> && <agy command>` under it, and dash does not replace itself with the last command. `sh` stays the pane's foreground process for agy's whole life, so `getPaneCommand` returns `sh`. `AgyRuntimeAdapter.checkReady` tested that label against the shell list before it read the screen, so a running agy was reported "not running in the pane (shell in the foreground)". `funnel-critic@leads` and `funnel-researcher@leads` failed readiness this way, with agy up and at its prompt. Found and hot-patched on ceres by the vespertin agy lane (w5Q:p5, 2026-11-09); this spec keeps the fix in the fork's source.

## Design

1. **exec the launch.** `AgyRuntimeAdapter.launchHarness` and `AgyResumeAdapter.resume` send `cd <cwd> && exec <wrapped command>`. The wrapped command for agy is always one simple command (`/usr/bin/env ... agy ...`, or bare `agy ...`), so `exec` is valid in front of it.
2. **Screen first.** `AgyRuntimeAdapter.checkReady` classifies the screen first, as `AgyResumeAdapter.verifyResume` already does. A shell label in the pane command returns `not_running` only when the screen is also unrecognized.

## Requirements

- REQ-0022-01: When the adapter launches or resumes agy, it shall send the command as `cd <cwd> && exec <command>`, so agy replaces the launch shell as the pane's foreground process.
- REQ-0022-02: When the pane command names a shell and the screen classifies as ready, trust or working, `checkReady` shall report the screen's state and not `not_running`.
- REQ-0022-03: When the pane command names a shell and the screen is unrecognized, `checkReady` shall report `not_running`.

## Plan

- [x] Add `exec` to the launch and resume commands.
- [x] Make `checkReady` screen-first.
- [x] Update the launch-command tests and add the screen-first case.
- [ ] Review the pane-closes-on-exit effect against seat restore before landing.

## Test


- Because agy now replaces the shell, a pane whose agy exits has no shell to fall back to, so the pane closes. Before, it dropped to the staging shell. Review this against seat restore when landing.
- Tests: `packages/daemon/test/agy-runtime-adapter.test.ts`. The launch-command expectations changed, and one new case covers REQ-0022-02. The resume path's `exec` has no test of its own.
