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
- **Pre-input pane read, any readiness.** Readiness alone can hide a dialog: a fresh `running` hook (`UserPromptSubmit`, `PreToolUse`), an `unknown` readiness, or an elicitation hook can all sit over a permission dialog. So an override send takes one fresh pane capture of a tmux target before `recordPromptOverride` and before any input, and classifies it:
  - a `permission_prompt` refuses with `permission_prompt_override_refused`, whatever the readiness state;
  - an unreadable pane (error or no content) refuses with `permission_check_unavailable` (HTTP 409): the override cannot prove no permission prompt is on screen. It fails closed.
- **Input boundary re-check.** Between that early read and the write, the send path awaits other work (the verify pre-capture, the recipient re-check, leaving copy mode), and a mid-work agent can raise a dialog in that window. So the override path reads the pane a second time immediately after leaving copy mode and immediately before the text is written, with the same two refusals (`permission_prompt_override_refused`, `permission_check_unavailable`; both "No text was sent."). The early read stays, because it refuses before the audit row exists. The audit row records the attempt; the boundary read may still refuse with no input sent. The residual window is the single capture-to-write round trip: a snapshot cannot be atomic.
- **Submit boundary (a further layer only).** The pre-submit capture of an override send is classified again. If it is a permission prompt, Enter is not sent and the result is `rendered-unconfirmed` with a warning. The answer text has already been typed by then, so this layer limits damage but does not replace the checks above.
- **Phrasings.** The permission patterns also cover approval questions found by searching the installed runtimes' binaries (counts only matched strings):
  - Codex 0.163.0 (`@openai/codex` linux-x64 `codex` binary): "Would you like to make the following edits?" (patch approval), "Would you like to grant these permissions?", "Would you like to send input to the existing terminal?", and "Do you want to approve network access to ...". The send-input pattern ends with the exact words `existing terminal`, so prose such as "send input to the server" does not match; the binary's id-suffixed variant ("send input to terminal <id>") is not matched.
  - Claude Code 2.1.304 (native binary): "Do you want to proceed?", "Do you want to continue?" and "Do you want to allow this connection?" were found; all three were already matched, so none was added.
- **Selection pickers keep the override.** A picker or question dialog that is not permission-class (an AskUserQuestion, an elicitation dialog) keeps the audited override.
- **Audit evidence.** `transport.prompt_override` carries `evidence` (the readiness evidence line, at most 120 characters, never the pane) and, for hook evidence, `rawEvent` and `rawSubtype`. Permission-class readiness is refused before the audit, so the excerpt is on-screen text of a non-permission prompt and may contain whatever that prompt shows.
- **Wording wins.** A picker whose own text contains a permission phrase ("Do you want to proceed ...") classifies as a permission prompt and its override is refused. This is intended: it errs toward refusing.

## Requirements

- REQ-0018-01: The pane classifier shall check permission and command-approval phrasings before selection prompts.
- REQ-0018-02: If a send carries the interact override and the target's readiness is a permission prompt from pane or hook evidence, then the transport shall refuse the send before any input is sent.
- REQ-0018-03: When it refuses such an override, the transport shall return the reason `permission_prompt_override_refused` and an error saying that a person must answer permission prompts in the pane.
- REQ-0018-04: When the pre-submit capture of an override send is a permission prompt, the transport shall not send Enter.
- REQ-0018-05: Where the target is a selection or question picker that is not a permission prompt, the transport shall keep the audited interact override.
- REQ-0018-06: When the transport records a prompt override, the record shall carry the detected evidence line truncated to 120 characters, and the raw hook event and subtype for hook evidence.
- REQ-0018-07: When a send to a tmux target carries the interact override, the transport shall refuse the send if one pane read taken before the override is recorded and before any input is a permission prompt, whatever the readiness state.
- REQ-0018-08: If the pane read before an override send is unavailable, then the transport shall refuse the send with the reason `permission_check_unavailable` before any input is sent.
- REQ-0018-09: The pane classifier shall treat the Codex patch, permission-grant, terminal-input and network approval questions as permission prompts.
- REQ-0018-10: When a send carries the interact override, the transport shall read the pane again immediately before writing the text, and refuse the send if that read is a permission prompt (`permission_prompt_override_refused`) or cannot be made (`permission_check_unavailable`).

## Plan

1. Branch `fix/sec-189-permission-before-selection`, one PR naming SEC-189.
2. Tests first, run red on the unmodified code, then the fix, then break-once on the reorder.

## Test

```bash
cd packages/daemon && npx vitest run test/send-prompt-guard.test.ts test/prompt-answer-delivery.test.ts test/session-transport-input-box.test.ts
```

- **Classifier:** a Claude dialog and a Codex approval, each with its selector, read `permission_prompt`; a plain picker reads `selection_prompt`.
- **Refusal:** pane evidence, a `PermissionRequest` hook, and a `Notification` `permission_prompt` hook each refuse the override with no text and no keys sent and no audit row.
- **Input boundary:** a clean early read followed by a dialog, or an unreadable pane, at the boundary refuses with no text or keys sent and the audit row present.
- **Codex pattern:** the real send-input question matches; "send input to the server" does not.
- **Pre-input read:** a running hook, an unknown readiness and an elicitation hook, each over a permission dialog, and an unreadable pane, refuse the override with nothing typed.
- **Boundary:** a pre-submit capture that turns into a permission dialog sends no Enter; the answer was already typed, which the test asserts.
- **Control:** an AskUserQuestion picker still sends under the override and writes one audit row.
- **Audit:** the row carries truncated evidence, plus `rawEvent` and `rawSubtype` for a hook.
