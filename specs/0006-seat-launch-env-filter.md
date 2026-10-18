---
status: complete
created: 2026-10-18
priority: high
scope: daemon, tmux, seat launch
author: ctodie
references: [SEC-178]
---

# 0006-seat-launch-env-filter

## Overview

A tmux server recreated from a herdr pane carries that pane's identity in its global environment: seven `HERDR_*` names, including the herdr server's control socket `HERDR_SOCKET_PATH`. Every seat launched on that server inherited them, so a seat could act as the native herdr pane. cw.4 already dropped five named herdr variables from fresh seats; `HERDR_SESSION`, `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH` still reached them, and the native resume probe dropped none. Containment on 2026-10-17 removed the keys from one server by hand (estate-onboarding/opus-swap-20261017/rina/herdr-env).

## Design

1. `packages/daemon/src/domain/seat-launch-env-filter.ts` names what a seat launch must not inherit: the launching session's identity (`parent-session-env.ts`) plus every name under the prefix `HERDR_`. It is a list of rules so the seat-env allow-list (SEC-178) can replace it.
2. The tmux adapter marks those names removed (`set-environment -r`) in the new session's environment and restarts the fresh pane, on all three launch paths: a fresh seat (`createSession`), a resume into the same pane (`respawnPane`) and the native resume probe (`createProbeSession`, newly covered).
3. The daemon's own process keeps `HERDR_SOCKET_PATH`: its herdr transport reads it. `removeParentSessionEnv` is unchanged.
4. Names only: no value is logged, and a cleanup failure is a launch warning, as before.

## Requirements

- REQ-0006-01: When the daemon creates a seat's tmux session, it shall mark every `HERDR_*` name in the server's global environment, other than names the launch sets explicitly, removed for that session.
- REQ-0006-02: When the daemon respawns a seat's pane, it shall mark every `HERDR_*` name in the server's global environment, other than names the launch sets explicitly, removed for that pane's session.
- REQ-0006-03: When the daemon creates a native resume probe session, it shall mark every `HERDR_*` name removed for that session and restart its pane.
- REQ-0006-04: The seat launch filter shall keep `OPENRIG_*` metadata, `TMUX` ancestry and credential variables.
- REQ-0006-05: The daemon shall keep `HERDR_SOCKET_PATH` in its own process environment.

## Plan

1. Fork PR #7 (`fix/herdr-env-filter`), landed on `cerebral` in merge `af21028b` (2026-10-18), shipped in cw.4.1 with the pane-mode readiness fix (PR #8).
2. Later (SEC-178): replace the deny rules with a seat-env allow-list.

## Test

```bash
cd packages/daemon && npx vitest run test/seat-launch-env-filter.test.ts test/seat-launch-env-tmux.test.ts test/tmux-adapter.test.ts test/tmux-argv-legacy-equivalence.test.ts
```

`seat-launch-env-tmux.test.ts` runs a private tmux server whose global environment carries a herdr pane's identity and reads the real pane process environment after a fresh launch and a probe launch.
