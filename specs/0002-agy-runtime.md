---
status: complete
created: 2026-10-18
priority: medium
scope: daemon, adapters, ui, tui
author: ctodie
references: []
---

# 0002-agy-runtime

## Overview

Retro spec for fork PR #1 (merged 2026-10-17, shipped in `0.6.10-cw.2`). OpenRig runs seats on the `agy` runtime (Google Antigravity CLI 1.4.0) beside `claude-code` and `codex`. This spec records the behaviour that is live in the fork, as implemented at `cerebral` `6d746c2a`.

## Design

1. **Adapter.** `packages/daemon/src/adapters/agy-runtime-adapter.ts`, modelled on the codex adapter. Startup context is delivered codex-style: guidance merged into `<cwd>/AGENTS.md`, skills into `<cwd>/.agents/skills/<name>/`, and `send_text` files typed into the ready TUI.
2. **Launch.** `agy --dangerously-skip-permissions`, plus `--mode <m>` when the seat sets one (`agyPostureArg`, `adapters/yolo-mode.ts`). The mode must be `accept-edits`, `auto` or `plan`; agy itself only warns on a bad mode, so OpenRig rejects it.
3. **Workspace trust.** Before launch, the seat cwd is added to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json`, keeping every other key. A non-array `trustedWorkspaces` is refused, not rewritten.
4. **Readiness** (`classifyAgyScreen`, `domain/agy-runtime.ts`), from recorded 1.4.0 captures in `test/fixtures/agy/`: the trust dialog wins over everything and is never answered; `esc to cancel` or a spinner means working; a `? for shortcuts` footer means ready.
5. **Resume.** `agy --conversation <uuid>`. The id exists only after the first turn, so it is captured later: the packaged PreInvocation hook `assets/agy-hook/openrig-agy-hook.sh` writes it to `$OPENRIG_HOME/state/agy/<session>.json`, and only when `OPENRIG_SESSION_NAME` is set. A fresh launch drops the previous occupant's sidecar.
6. **Hook registration.** The hook is registered as `openrig` in the global `~/.gemini/config/hooks.json` by a textual splice, so other hooks (for example `moshi-hook`) stay byte-for-byte unchanged, and an identical block is not rewritten.
7. **Surfaces.** `runtime-verifier.ts` proves the binary with `agy --version`; the UI and TUI carry an `agy` brand and mark.

## Requirements

- REQ-0002-01: When a seat with runtime `agy` launches fresh, the daemon shall start `agy --dangerously-skip-permissions` in the seat's tmux session.
- REQ-0002-02: If a seat's agy mode is not `accept-edits`, `auto` or `plan`, then the daemon shall refuse the launch.
- REQ-0002-03: Before an agy launch, the daemon shall add the seat cwd to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` without changing any other key.
- REQ-0002-04: While an agy pane shows the workspace trust dialog, the adapter shall report the seat as not ready without answering the dialog.
- REQ-0002-05: When an agy pane shows the `? for shortcuts` footer and no working indicator, the adapter shall report the seat as ready.
- REQ-0002-06: Where an agy seat has a captured conversation id, the daemon shall resume it with `agy --conversation <uuid>`.
- REQ-0002-07: The agy hook script shall write a conversation id only when `OPENRIG_SESSION_NAME` is set.
- REQ-0002-08: When the daemon registers its agy hook, it shall leave every other hook in `~/.gemini/config/hooks.json` byte-for-byte unchanged.

## Plan

Implemented in fork PR #1 and carried through the cw.4 rebase: `8d70d3c1` (runtime), `1e7f2d2c` (UI and TUI marks), `73e40a66` (byte-exact `hooks.json` splice and deferred token refresh).

## Test

```bash
cd packages/daemon && npx vitest run test/agy-runtime.test.ts test/agy-runtime-adapter.test.ts
```

PR #1 recorded 33 and 27 cases in these suites, plus agy cases in the preflight, verifier, validation, UI and TUI suites, and 24 seeded mutations that each turned a test red. At `6d746c2a` the two suites pass 60 cases.
