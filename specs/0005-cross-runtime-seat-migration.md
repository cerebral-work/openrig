---
status: planned
created: 2026-10-18
priority: high
scope: daemon, cli, handover, seat-lifecycle
author: dev-design@vilicus
references: [0001-fork-distribution-model]
---

# 0005-cross-runtime-seat-migration

## Overview

OpenRig cannot change a seat's runtime, Codex to Claude Code or back, while keeping the seat's address and lineage. The operator found this before the Opus swap (estate evidence `opus-swap-20261017/FIRST-RED.md`). The workaround was to take the rig down, edit the rig spec and bring it up again. That archives the rig and changes the rig and node ids, so it is not a product path. This spec is the supported path: the seat keeps its address, queue custody and history, the runtime change is recorded with provenance, and the successor starts with an honest recap.

The path must never fake a runtime hint, patch the database, remove and re-add the seat, or substitute a new rig id.

Line references are to `cerebral` at `6d746c2a` (cw.4). Paths are under `packages/daemon/src` unless stated otherwise.

## Design

### Current behaviour (6d746c2a)

- **The node is the seat.** `nodes.id` is "the identity that IS stable across handover/swap/repair" (`db/migrations/060_occupant_tenures.ts:13`).
  - The address `member@rig` resolves to the node (`domain/seat-status-service.ts:79-92`).
  - A `sessions` row is a registration. The append-only `occupant_tenures` table records each occupant generation (`060_occupant_tenures.ts:21-31`).
- **No handover creates a node.** The four handover sources are `fresh`, `rebuild`, `fork:<ref>` and `discovered:<ref>` (`domain/seat-handover-planner.ts:4`).
  - `fresh`, `rebuild` and `fork` start the successor in the departing pane under the same session name (`domain/seat-handover-service.ts:447-449, 684-691`).
  - Each mints a new tenure and supersedes the old session rows.
- **`nodes.runtime` is written only when the node is created** (`domain/rig-repository.ts:407,436,464`). The handover reads it to pick the successor's adapter (`seat-handover-service.ts:472`; `domain/successor-session-launcher.ts:285,317`).
  - `nodes.model` already has one supported writer: `setNodeModel`, used by `rig seat set-model` (`rig-repository.ts:512-518`; `domain/seat-lifecycle-service.ts:274`).
- **Today a runtime difference is always a refusal:**
  - native fork (`seat-handover-service.ts:392-399`);
  - discovered successor, `checkRuntimeMismatch` (`:917-927`, called at `:699`);
  - first-start retry (`domain/rigspec-instantiator.ts:1200-1209`).
  - Materialize also refuses a duplicate pod or logical id (`rigspec-instantiator.ts:694-702`).
- **Some stored state is bound to one runtime:**
  - an explicit permission selection is keyed by runtime and throws on a mismatch (`domain/native-permission-store.ts:49-51, 87-89`; migration 088);
  - the persisted startup context carries a runtime (migration 015; `seat-lifecycle-service.ts:782-787`);
  - `sessions.resume_type` and `resume_token` (migration 006);
  - `nodes.codex_config_profile` is Codex-only (`rigspec-schema.ts:492-493`), as are Codex's permission modes `floor` and `full_bypass` (`native-permission-store.ts:64-67`);
  - `nodes.effort` and `effort_choice` use each runtime's own levels.
- **Queue custody is by name, not by runtime.** `destination_session` is a plain string. Delivery resolves it by node id, tmux session or pane, `logical_id` or `logical_id@rig` (`domain/seat-delivery-guard.ts:279-295`; `domain/session-transport.ts:1699-1745`). A wake committed against the old occupant fails with `guard_target_changed` (`session-transport.ts:1909-1915`).
- **Recap:** `buildRestorePacket` (`seat-handover-service.ts:1176-1244`). The predecessor recap resolver reads Codex rollouts or Claude sidecars according to its `runtime` argument (`domain/predecessor-recap-resolver.ts:57-89`). The handover passes `node.runtime` (`seat-handover-service.ts:439`).

### CLI: a target runtime on `rig seat handover`

```text
rig seat handover <seat> --source fresh|rebuild --to-runtime <runtime> --to-model <model>
    [--to-permissions <mode>|inherit] [--to-effort <level>] --reason <text> [--operator <address>] [--dry-run] [--json]
```

**Why handover and not a new verb.**
- A runtime cannot change under a live occupant; it changes only when a new occupant starts.
- The handover already owns that cutover: it stops the departing occupant, starts the successor in the same pane under the same name, mints the tenure, supersedes the old sessions, delivers the recap packet and records the event.
- `set-model` only edits a value for the next launch and starts nothing.
- A separate `set-runtime` verb would either duplicate the cutover, or leave a node whose runtime disagrees with its live occupant.

**Sources:**
- `fresh` and `rebuild` support `--to-runtime`.
- `fork` refuses it, because a native fork cannot cross harnesses.
- `discovered` accepts it only when the discovered session's runtime hint equals the target.

**Explicit flags:**
- `--to-model` is required.
- `--to-permissions` is required when the seat has an explicit permission selection.
- With `--dry-run`, the command prints the full transition plan and changes nothing.

### Identity: the same node with a new tenure

The seat keeps its `nodes.id`, logical id, pod, rig, binding, canonical session name and address. The runtime change is a new occupant tenure, not a new node:
- **Custody and delivery keep working:** they key on the node and the session name (Current behaviour).
- **Seat state survives:** node-keyed rows (`node_permission_selections`, guards, tenures) cascade on node deletion (migration 088 `ON DELETE CASCADE`), so a new node would lose them.
- **A second node is not possible in place:** a second node at the same logical id is refused (`rigspec-instantiator.ts:698-702`).

So `nodes.runtime` becomes writable, and only inside the commit of a runtime-changing handover. The changes:
1. `occupant_tenures` gains a `runtime` column, so each tenure records the runtime it ran.
2. A new append-only `node_runtime_changes` table records provenance: node, tenure, from and to runtime, model, permission and effort, operator, reason, time and outcome.
3. A `seat.runtime_changed` event is persisted with the same fields.

### The refusal becomes a declared transition

`checkRuntimeMismatch` compares the successor against the declared target (`--to-runtime`, or the node's runtime when no target is given). A difference is therefore either a declared, audited transition or a refusal that names `--to-runtime`. The fork refusal stays, with guidance to use `fresh` or `rebuild` with `--to-runtime`.

### Runtime-bound state at commit

| State | On commit |
|---|---|
| `nodes.runtime`, `nodes.model` | Set to `--to-runtime` and `--to-model` |
| `nodes.effort_choice` | Set to `--to-effort`, or cleared |
| `nodes.codex_config_profile` | Cleared unless the target is `codex` |
| `node_permission_selections` | Replaced by `--to-permissions <mode>`, validated for the target runtime, or deleted for `inherit` |
| Persisted startup context | Replaced by the successor's own startup context |
| Old `sessions` rows | Superseded, keeping their `resume_type` and `resume_token` as the predecessor link |
| New `sessions` row and tenure | Carry the target runtime's resume type and the tenure runtime |

Where the seat had an explicit permission selection and `--to-permissions` is absent, the command refuses before any mutation. A permission is never widened silently.

### Queue custody

Rows addressed to the seat stay addressed to it. The recap packet lists the open rows whose destination is the seat. Wakes committed against the old occupant fail as `guard_target_changed` and resolve to the successor (existing behaviour). After commit, the successor is nudged for its open rows.

### History and recap

The successor starts fresh: no native history crosses harnesses. The recap resolver is called with the predecessor's runtime, so a Codex predecessor's rollout is read. The packet's first line states the change plainly: "Runtime changed from codex to claude-code; the predecessor conversation is not resumed." It then gives the predecessor record's path.

The predecessor transcript stays where its runtime wrote it. It stays reachable through the superseded session row and the tenure ledger.

### Failure and rollback

The transition runs in five phases:
1. **Preflight** (`--dry-run` stops here). Check:
   - the target adapter is installed and its binary is on the launch PATH;
   - the model is valid and the permission mode is valid for the target;
   - the recap resolves;
   - no handover is in progress.
2. **Capture:** the pane, the open rows, and the node's runtime-bound state.
3. **Cutover:** stop the predecessor, then start the successor with the target adapter in the same pane.
4. **Verify:** the launch file is consumed, a live process of the target harness is under the pane, the adapter reports ready, and the recap packet is delivered.
5. **Commit:** one transaction for every row in the table above, plus the ledger row and the event.

Nothing about the node changes before phase 5. If phase 3 or 4 fails:
- the successor process is stopped;
- the node keeps its old runtime, model and permissions, and the predecessor session is not superseded;
- the attempt is recorded with outcome `failed`;
- the predecessor stays restorable by resuming its recorded token under its own runtime.

The successor accepting the handoff, by answering the packet, is observed after commit. If it is missing within the readiness window, the seat is marked for attention; the transition is not rolled back.

## Requirements

- REQ-0005-01: The `rig seat handover` command shall accept a `--to-runtime` option that names the successor's runtime.
- REQ-0005-02: When `--to-runtime` differs from the seat's runtime, the handover shall require `--to-model` and refuse before any mutation if it is absent.
- REQ-0005-03: If the seat has an explicit permission selection and `--to-permissions` is absent, then the handover shall refuse a runtime change before any mutation.
- REQ-0005-04: When a runtime change commits, the daemon shall keep the seat's node id, logical id, pod, rig, binding and canonical session name unchanged.
- REQ-0005-05: When a runtime change commits, the daemon shall write the node's runtime, model, effort choice, Codex profile and permission selection in the same transaction as the new tenure.
- REQ-0005-06: The daemon shall write `nodes.runtime` only at node creation and in the commit of a runtime-changing handover.
- REQ-0005-07: When a runtime change commits, the daemon shall append a `node_runtime_changes` row recording the node, tenure, from and to runtime, model, permission, operator, reason and time.
- REQ-0005-08: When a runtime change commits, the daemon shall record the target runtime on the new occupant tenure.
- REQ-0005-09: While a runtime change is in progress, the daemon shall leave queue rows addressed to the seat unchanged.
- REQ-0005-10: When a runtime change starts the successor, the handover shall deliver a recap packet that states the runtime change and that the predecessor conversation is not resumed.
- REQ-0005-11: When a runtime change builds its recap, the handover shall resolve the predecessor record with the predecessor's runtime.
- REQ-0005-12: If the successor launch or its verification fails, then the daemon shall leave the node's runtime, model, permissions and predecessor session unchanged and record the attempt as failed.
- REQ-0005-13: If a fork source's runtime differs from the seat's runtime, then the handover shall refuse and name `--to-runtime` with a `fresh` or `rebuild` source.
- REQ-0005-14: Where a discovered successor's runtime hint equals `--to-runtime`, the handover shall accept it as the declared transition.
- REQ-0005-15: When `--dry-run` is given with `--to-runtime`, the handover shall print the full transition plan and change nothing.
- REQ-0005-16: The daemon shall commit a runtime change only after the launch file is consumed, a live process of the target harness is under the pane, and the adapter reports ready.

## Plan

1. **This spec.** Advisor decisions D1 to D5 (Notes) are routed by the lead.
2. **Schema.** Migration adding `occupant_tenures.runtime`, backfilled from `nodes.runtime`, and the `node_runtime_changes` table. Plus `RigRepository.setNodeRuntime`, callable only from the handover commit.
3. **Planner and CLI.** The `--to-runtime`, `--to-model`, `--to-permissions` and `--to-effort` options, the source rules, and the dry-run plan.
4. **Service.** Preflight, recap with the predecessor runtime, the target adapter in the launcher, verification gates, the single-transaction commit, failure handling, and the `seat.runtime_changed` event.
5. **Tests.** Below, then a scenario run on a scratch rig before any live seat is changed.

## Test

- **Planner.** `--to-runtime` is accepted for `fresh` and `rebuild` and refused for `fork`. `discovered` is accepted only when its hint matches. The flag-requirement refusals happen before mutation.
- **Service, mocked.**
  - The commit changes exactly the runtime-bound rows, writes the ledger row and the tenure runtime, and leaves custody rows untouched.
  - Without `--to-permissions`, an explicit permission row blocks the change.
  - A failed launch leaves the node and the predecessor session as they were, and records `failed`.
- **Recap.** For a Codex predecessor with a Claude successor, the packet reads the Codex rollout and states the runtime change.
- **Real tmux, end to end.** Copy `test/seat-handover-cutover-e2e.test.ts`: an isolated `-L` socket, the real `SeatHandoverService`, and stand-in `codex` and `claude` binaries on the launch PATH. A Codex seat is handed over with `--to-runtime claude-code --to-model claude-opus-5-5`. Then assert:
  - the same pane and session name;
  - the new runtime and model;
  - a queue row addressed to the seat is still delivered;
  - the launch file is consumed, and the stand-in Claude is a live descendant of the pane;
  - the adapter reports ready.
  - A second case makes the stand-in Claude exit at once. The node and the predecessor session must stay unchanged, and the predecessor must resume under Codex.
- **CLI.** Option parsing, the required flags, and the dry-run output.

## Notes

### Decisions for the advisor

- **D1 (seat contract).** Same node with a new tenure, which makes `nodes.runtime` writable through one path (recommended); or a new node in the same seat lineage. The second needs a lineage ledger that does not exist today, and loses node-keyed state.
- **D2 (spec drift).** After a change, the rig spec's member runtime disagrees with the node, and first-start retry refuses that (`rigspec-instantiator.ts:1200-1209`). The options:
  - (a) The node overrides the spec, recorded with provenance and reported as drift until the spec is edited.
  - (b) The handover refuses unless the rig spec already declares the target runtime and model.
  - (c) The handover edits the spec.
  - Lean: (b). The spec stays the source of truth, and an edit-first order keeps every restore consistent.
- **D3 (authority).** May any seat run a runtime change on any seat, or only the kernel operator with Christian's go, as with installs?
- **D4 (permission default).** When the old seat inherited its permissions, does `inherit` on the target runtime need confirming (recommended: it is printed in the dry run), or should it take effect silently?
- **D5 (handoff acceptance).** Observe the successor's acceptance after commit and mark attention if it is missing (proposed), or hold the commit until the successor answers?

### Not in this spec

Runtimes other than `codex` and `claude-code` in the first slice, a pod-wide or rig-wide change, and the UI.

XERJ has no OpenRig index (checked 2026-10-18; a control query on the vilicus prefix answered). The references above are direct reads of `6d746c2a`.
