---
status: complete
created: 2026-10-18
priority: high
scope: daemon, launcher, tmux
author: ctodie
references: [CER-2889]
---

# 0003-fresh-shell-launch-readiness

## Overview

Retro spec for fork PR #3 (CER-2889, merged 2026-10-17, shipped in `0.6.10-cw.3`) and its cw.4 follow-up `e5ce2ce2`. A fresh managed seat no longer receives its runtime launch before the new shell can execute it, and launch readiness tells an unconsumed launch script apart from a busy wrapper and from a runtime that exited back to the shell. As implemented at `cerebral` `6d746c2a`.

## Design

1. **Size.** New detached tmux sessions start at 160x48 (`packages/daemon/src/adapters/tmux.ts`, `new-session -x 160 -y 48`).
2. **Fresh-shell handshake.** A session the production adapter creates is marked fresh. Before the first shell command into it, `waitForFreshShell` needs positive idle-shell process evidence before every write, then a computed marker (`openrig_ready_<nonce>`) printed on its own line. Echoed input does not count. If the shell never executes the probe, the result is `shell_not_ready` and no launch input is sent.
3. **Production only.** The handshake is a `TmuxAdapter` option that `createDaemon` sets at its one production construction site (`packages/daemon/src/startup.ts`, `{ handshake: true }`). A bare adapter keeps upstream's one-paste, one-Enter contract (`e5ce2ce2`).
4. **Launch readiness codes.** The Claude and Codex adapters distinguish `launch_not_executed` (the staged script was never consumed), `awaiting_runtime` (a wrapper is still busy) and `returned_to_shell` (proven return to an idle shell). The runtime invocation itself is never retried.
5. **Scope.** Existing and adopted seats keep their input behaviour. Prompt guards and permissions are unchanged.
6. **Pane modes** (fork PR #8). A failing cosmetic tmux hook (session-created or client-attached) can leave the fresh pane in view-mode, and while a read-only client is attached, keys sent to a pane in a mode fail. Before each handshake write, `waitForFreshShell` reads `#{pane_in_mode}` and leaves any mode with `copy-mode -q`. The pane was created for this launch, so no user state is lost.

## Requirements

- REQ-0003-01: When the daemon creates a detached tmux session for a seat, it shall size the session 160 columns by 48 rows.
- REQ-0003-02: Before the first launch input into a fresh session, the production daemon shall obtain idle-shell process evidence and a shell-executed computed marker.
- REQ-0003-03: If a fresh shell does not print the computed marker, then the daemon shall return `shell_not_ready` without sending launch input.
- REQ-0003-04: The daemon shall not treat tty echo of the readiness probe as evidence that the shell executed it.
- REQ-0003-05: Where a `TmuxAdapter` is constructed without the handshake option, the adapter shall send one paste and one Enter per command.
- REQ-0003-06: If a staged launch script is never consumed, then the Claude and Codex adapters shall report `launch_not_executed`.
- REQ-0003-07: When a runtime returns to an idle shell, the Claude and Codex adapters shall report `returned_to_shell` without retrying the runtime invocation.
- REQ-0003-08: If a fresh pane is in a tmux mode before a handshake write, the production daemon shall leave that mode before writing.

## Plan

Implemented in fork PR #3 (`917f2ddf` in cw.3; `6c5fc49f` after the cw.4 rebase), narrow backports of upstream `c336df24` (#1364), `3053354c` (#1373) and the readiness part of `a2a37b16` (#1395). cw.4 gated the handshake to production startup in `e5ce2ce2`. REQ-0003-08 is fork PR #8 (`fix/pane-mode-readiness`, cw.4.1), landed on `cerebral` in merge `ba027aac` (2026-10-18).

## Test

```bash
cd packages/daemon && npx vitest run test/fresh-shell-launch.test.ts test/startup-wiring-pins.test.ts
cd packages/daemon && npx vitest run test/fresh-shell-pane-mode.test.ts   # REQ-0003-08
```

At `6d746c2a` the two suites pass 48 cases (5 todo). `startup-wiring-pins.test.ts` fails if production stops enabling the handshake. Stub-agent scenarios do not use staged Claude or Codex launches, so the first end-to-end proof is a real seat launch after install. `fresh-shell-pane-mode.test.ts` runs a private tmux server where a failing session-created hook leaves the new pane in view-mode and a read-only client is attached; without REQ-0003-08 the launch ends in `shell_not_ready`.
