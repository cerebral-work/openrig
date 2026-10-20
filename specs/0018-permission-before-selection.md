---
status: in-progress
created: 2026-10-19
priority: high
scope: daemon, transport, rig send
author: fork-maintainers
references: [SEC-189]
---

# 0018-permission-before-selection

## Overview

`rig send --dangerously-interact` can answer a permission or command-approval dialog (SEC-189). Two causes, both in `packages/daemon/src/domain/session-transport.ts`:

- **Order.** `classifyPaneActivity` checks the selector patterns before the permission phrasings. A Claude dialog ("Do you want to proceed?" over `❯ 1. Yes / 2. ... / 3. No`) and a Codex command approval ("Would you like to run the following command" over `› 1.` choices) therefore classify as `selection_prompt`, not `permission_prompt`.
- **No permission-class refusal.** With the override, the send path records `transport.prompt_override` and sends for any `needs_input` reason, `permission_prompt` included. Runtime hooks (`PermissionRequest`, `PermissionPromptConfirmed`, `Notification` with subtype `permission_prompt`) reach the same path.

In a Claude permission dialog a digit key selects an option at once, so the send must be refused before any keystroke.

## Design

- **Classify permission first.** `classifyPaneActivity` checks the permission phrasings before the selection check. Every other branch keeps its order.
- **One predicate.** `readinessIsPermissionPrompt(readiness)` is true for:
  - pane reason `permission_prompt`;
  - hook reasons `permission_request_pending` and `permission_request_unverified`;
  - a hook `rawEvent` of `PermissionRequest` or `PermissionPromptConfirmed`, or `Notification` with `rawSubtype` `permission_prompt`.
- **Refuse before input.** With `dangerouslyInteract` and a `needs_input` readiness the predicate accepts, the send returns `ok: false`, reason `permission_prompt_override_refused` (HTTP 409), before `recordPromptOverride` and before any input.
- **Submit boundary.** The pre-submit capture of an override send is classified again. If it is a permission prompt, Enter is not sent and the result is `rendered-unconfirmed` with a warning.
- **Selection pickers keep the override.** A picker or question dialog that is not permission-class (an AskUserQuestion, an elicitation dialog) keeps the audited override.
- **Audit evidence.** `transport.prompt_override` carries `evidence` (the readiness evidence line, at most 120 characters, never the pane) and, for hook evidence, `rawEvent` and `rawSubtype`.

## Requirements

- REQ-0018-01: The pane classifier shall check permission and command-approval phrasings before selection prompts.
- REQ-0018-02: If a send carries the interact override and the target's readiness is a permission prompt from pane or hook evidence, then the transport shall refuse the send before any input is sent.
- REQ-0018-03: When it refuses such an override, the transport shall return the reason `permission_prompt_override_refused` and an error saying that a person must answer permission prompts in the pane.
- REQ-0018-04: When the pre-submit capture of an override send is a permission prompt, the transport shall not send Enter.
- REQ-0018-05: Where the target is a selection or question picker that is not a permission prompt, the transport shall keep the audited interact override.
- REQ-0018-06: When the transport records a prompt override, the record shall carry the detected evidence line truncated to 120 characters, and the raw hook event and subtype for hook evidence.

## Plan

1. Branch `fix/sec-189-permission-before-selection`, one PR naming SEC-189.
2. Tests first, run red on the unmodified code, then the fix, then break-once on the reorder.

## Test

```bash
cd packages/daemon && npx vitest run test/send-prompt-guard.test.ts test/prompt-answer-delivery.test.ts test/session-transport-input-box.test.ts
```

- **Classifier:** a Claude dialog and a Codex approval, each with its selector, read `permission_prompt`; a plain picker reads `selection_prompt`.
- **Refusal:** pane evidence, a `PermissionRequest` hook, and a `Notification` `permission_prompt` hook each refuse the override with no text and no keys sent and no audit row.
- **Boundary:** a pre-submit capture that turns into a permission dialog sends no Enter.
- **Control:** an AskUserQuestion picker still sends under the override and writes one audit row.
- **Audit:** the row carries truncated evidence, plus `rawEvent` and `rawSubtype` for a hook.
