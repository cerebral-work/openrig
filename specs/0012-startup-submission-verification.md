---
status: in-progress
created: 2026-10-18
priority: low
scope: daemon, startup, claude adapter
author: ctodie
references: [revenant fresh-launch gap 1]
---

# 0012-startup-submission-verification

## Overview

On a fresh Claude Opus launch of revenant (2026-10-17 23:45Z), `rig up` returned `completed` with "Startup submission is unverified: the current composer boundary was not recognized" for both startup sends: the identity bundle and the required `startup/context.md`.

**Both were in fact delivered.**
- The identity bundle was the seat's first turn.
- `context.md` was typed while Claude was still on that first turn. Claude queued it: an enqueue at 23:45:11.080Z, a dequeue at 23:50:16.382Z. It then arrived as the next user turn, byte-equal after whitespace normalization.

**What failed was the check, not the delivery.**
- About 400 ms after Enter, the screen had a prompt marker but no closing rule followed by a recognised footer (`closingRuleLine` null).
- The check looks again only for our own collapsed paste.
- A required file left unverified still reported `completed`.

Neither cw.4.1 fix touches this path: #8 changes `adapters/tmux.ts`, #1359 changes `claude-code-adapter.ts` resume.

## Design

1. **Re-look while the boundary is unrecognised.** The startup check looks again every 200 ms, up to `STARTUP_SUBMIT_BOUNDARY_LOOKS` = 10 looks (about 2 s).
   - It continues only while the composer region has no marker or no closing rule.
   - Observation only: it never pastes again and never presses Enter again.
   - The existing collapsed-paste settle (25 looks) is unchanged.
2. **Confirm from the seat's own transcript (runtime-adapter scoped).** This applies when the screen still cannot verify a send. A runtime adapter may implement `confirmStartupText`; the orchestrator calls it for any runtime that has it and holds no Claude-specific logic.
   - The Claude adapter reads exactly one file: `<claude config dir>/projects/<encoded cwd>/<session id>.jsonl`.
     - `<session id>` is the id the launch being confirmed passed itself, and the orchestrator passes it in. It is one of:
       - the generated `--session-id` of the orchestrator's own fresh launch;
       - the exact id of its own `--resume`;
       - for a launch made elsewhere (a legacy restore that the old Claude resume helper resumed, then `skipHarnessLaunch`), the exact id that resume passed, given as `launchSessionId`.
     - The adapter never takes the id from its own record of a node's last launch. That record can belong to an earlier occupant of the same node.
     - A fork launch is not confirmed and reports "unavailable": how its new file carries the parent conversation's records is not established here.
     - A `rig seat continue` of a fresh launch also reports "unavailable", because the continuation does not carry the launch's id. Recording the id on the pending event would close this; it is not built here.
     - It is never located by name or glob. No session id for this launch, or a missing file, means "unavailable".
   - It counts only records timestamped after the send.
   - **Verified:** a `user` record or an `attachment` record whose text, or a `<pasted_content>` block in it, has the same SHA-256 as the sent text after whitespace normalization.
   - **Enqueued, unconfirmed:** no user or attachment match, but a post-send `queue-operation` enqueue is attributable to this send. It is either the single text-free enqueue (Claude records a queued paste without its text) or an enqueue whose text has the sha. Queued is not consumed, so this is never verification.
   - Read-only. Diagnostics record record types, counts and hashes, never text.
   - **This reverses the rule in `ClaudeCodeAdapter.launchHarness`** that nothing is read back from Claude's session files, because a same-name file can belong to an earlier occupant.
     - The reversal is narrow: this check only, and only the file named by this launch's own session id, read after our send. On a fresh launch that id is a random UUID this launch generated.
     - A future fork sync must keep this reversal visible.
   - **Known limits.**
     - A resume that Claude continues under a new id never confirms: `--resume T1` writes to T2 (#1077), and only T1's file is read. It gets `not_found`, which fails safe.
     - A symbolic link at the session-file path is followed; only the cwd is resolved. Planting one needs write access to the Claude config directory as the same user.
3. **A required send that is still unverified is `attention_required`.** This is a behaviour change.
   - Which sends count as required:
     - a post-launch `send_text` file with `required: true`;
     - the identity bundle or restore preload when it carries such a file's content.
   - When one of these is unverified after the screen looks and the transcript check, startup ends `attention_required` instead of `ready`. Every remaining step still runs first.
   - The failure is raised with `freshContextPending` false, so `rig seat continue` cannot replay it. Nothing is ever resent.
   - The message says the text was sent and may be queued.
   - A single text-free enqueue gets the distinct reason `startup_text_enqueued_unconfirmed`, with the enqueue timestamp.
   - A send that is not required keeps today's warning.
   - A **staged** send is unchanged: the prompt is still visible in the composer after the guarded retries, so startup stays ready with today's "press Enter in that pane" warning. That is a positive observation, not an unverified one.
   - The boundary re-look applies to any capture with no marker or no closing rule. That includes a screen that replaced our collapsed paste with something unreadable, which before this change kept its first-look verdict at once.
4. **Diagnostics record the footer's class, never its text.** Each observation records `footerClass`: the first non-blank line after the last rule, as `mode_bar | paste_hint | shortcuts_hint | vim_insert | blank_rule_tail | unrecognized | no_rule`. It is fixed-size, with no excerpt.

## Requirements

- REQ-0012-01: While a startup send's composer region has no marker or no closing rule, the startup orchestrator shall look again every 200 ms for at most `STARTUP_SUBMIT_BOUNDARY_LOOKS` (10) looks without sending any text or key.
- REQ-0012-02: When the screen cannot verify a startup send and the seat's runtime adapter implements `confirmStartupText`, the startup orchestrator shall treat a transcript sha match after the send as a verified submission.
- REQ-0012-03: The Claude adapter shall read only the transcript file named by the session id that the startup orchestrator passes for the launch being confirmed, and only records timestamped after the send.
- REQ-0012-04: The Claude adapter shall report an attributable post-send enqueue without a user or attachment sha match as `enqueued_unconfirmed`, never as verified.
- REQ-0012-05: When a required startup send is unverified after the screen looks and the transcript check, the startup orchestrator shall end startup `attention_required` without resending any text.
- REQ-0012-06: Each startup submission observation shall record its footer class from a fixed set and no pane text.
- REQ-0012-07: If the launch being confirmed is a fork or has no session id it passed itself, then the startup orchestrator shall report its transcript confirmation unavailable without calling the runtime adapter.

## Plan

1. Fork branch `fix/startup-verify-composer-boundary` from `cerebral` `bb18ae68`; a PR on hold, shipping in a release after cw.4.1.
2. Follow-up, not built here: a background reconcile that marks an `enqueued_unconfirmed` send verified once its turn is consumed and its sha appears in the transcript.

## Test

```bash
cd packages/daemon && npx vitest run test/startup-submit-confirmation.test.ts test/startup-submission-evidence.test.ts test/claude-startup-transcript.test.ts
cd packages/daemon && npx vitest run test/restore-orchestrator.test.ts -t "exact id it resumed"
```

- **Re-look:** a boundary unrecognized for 3 looks then clear gives verified, in 4 captures. A boundary never recognized takes exactly 11 captures and one paste plus one Enter.
- **Transcript:**
  - The orchestrator receives the sent text and the send time.
  - The pure inspector counts only post-send records, matches user and `queued_command` attachment text by sha, separates a text-free or matching enqueue, and never returns text.
  - The adapter reads only the file for the id it is given. After launching generation 1 as `earlier-occupant`, confirmation for generation 2 reads only generation 2's file and never generation 1's, even though generation 1's would verify. A missing file is unavailable.
  - The orchestrator passes the launch's own id:
    - the id its launch reports;
    - for a skipped launch, `launchSessionId`; with none, confirmation is never called and a required send ends `attention_required`;
    - for a fork, confirmation is never called.
  - A legacy Claude restore hands startup the exact id it resumed (`restore-orchestrator.test.ts`).
- **Required:** each unverified path (unrecognized boundary, unavailable or thrown capture, mismatched composer, enqueued-unconfirmed, a required post-launch file) ends `attention_required` with one paste and one Enter. A non-required send keeps today's warning.
- **Existing cases** now use a non-required default role file. They pin the screen check's mechanics, and the required outcome has its own cases. Two cases changed deliberately:
  - the re-look after a collapsed paste gives way (12 captures);
  - the initial unrecognized-boundary label (11 captures, first and last look recorded).
- **Break-once:** each mechanism was broken and shown red:
  - the re-look, the transcript call, the required collection, the post-send floor, enqueue-as-verified and the own-path read;
  - review r1's must-fix: the adapter's own last-launch record restored, the fork exclusion dropped, the restore's resumed id not passed, and `launchSessionId` ignored.
