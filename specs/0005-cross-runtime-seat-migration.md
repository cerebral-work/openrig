---
status: complete
created: 2026-10-18
priority: high
scope: daemon, cli, handover, seat-lifecycle
author: dev-design@vilicus
references: [0001-fork-distribution-model, SEC-178]
---

# 0005-cross-runtime-seat-migration

## Overview

OpenRig could not change a seat's runtime, Codex to Claude Code or back, while keeping the seat's address and lineage. The operator found this before the Opus swap (estate evidence `opus-swap-20261017/FIRST-RED.md`). The workaround was to take the rig down, edit the rig spec and bring it up again. That archives the rig and changes the rig and node ids, so it is not a product path. This spec is the supported path: the seat keeps its address, queue custody and history, the change is recorded with provenance, the successor starts with its own runtime's startup and an honest recap, and the change can be reverted.

The path never fakes a runtime hint, patches the database, removes and re-adds the seat, or substitutes a new rig id.

Decisions D1 to D5 were accepted by Christian on 2026-10-18; Q1 to Q5 and the recovery shape were ruled by the lead the same day (Notes). Line references are to `cerebral` at `6d746c2a` (cw.4). Paths are under `packages/daemon/src` unless stated otherwise.

## Design

### Before this spec (6d746c2a)

- **The node is the seat.** `nodes.id` is "the identity that IS stable across handover/swap/repair" (`db/migrations/060_occupant_tenures.ts:13`). The address `member@rig` resolves to the node (`domain/seat-status-service.ts:79-92`). A `sessions` row is a registration; `occupant_tenures` records each occupant generation.
- **No handover creates a node.** `fresh`, `rebuild` and `fork` start the successor in the departing pane under the same session name (`domain/seat-handover-service.ts:447-449, 684-691`).
- **`nodes.runtime` was written only at node creation** (`domain/rig-repository.ts:407,436,464`), and a runtime difference was always a refusal: native fork (`seat-handover-service.ts:392-399`), discovered successor (`:917-927`), first-start retry (`domain/rigspec-instantiator.ts:1200-1209`).
- **Runtime-bound state:** the explicit permission selection is keyed by runtime (`domain/native-permission-store.ts:49-51`); the persisted startup context carries a runtime (`seat-lifecycle-service.ts:782-787`); `nodes.codex_config_profile` is Codex-only; effort levels differ per runtime.
- **The handover runs no projection:** a same-runtime successor finds the predecessor's projected files on disk. Claude projects to `<cwd>/.claude` and the `CLAUDE.md` block; Codex to `<cwd>/.agents`, `AGENTS.md` and `~/.codex/config.toml` hooks.
- **Queue custody is by name, not runtime** (`domain/seat-delivery-guard.ts:279-295`). The predecessor recap reads Codex rollouts or Claude sidecars by its `runtime` argument (`domain/predecessor-recap-resolver.ts:57-89`).
- **The kernel rig's spec is the packaged builtin**, chosen by an auth probe and rewritten at each install. A managed kernel never re-reads it (`domain/kernel-boot.ts:96-101`); restore relaunches from node rows.

### CLI

```text
rig seat handover <seat> --source fresh|rebuild --to-runtime codex|claude-code --to-model <model>
    --to-permissions floor|full_bypass|inherit --spec <rig.yaml> --approval <ref> --reason <text>
    [--to-cwd <path>] [--to-env NAME=VALUE ...] [--to-effort <level>] [--dry-run] [--json]
rig seat runtime-revert <seat> --approval <ref> --reason <text> [--resume-predecessor] [--dry-run] [--json]
rig seat runtime-declare <seat> [--json]
```

A runtime changes only when a new occupant starts, and handover already owns that cutover, so the change rides on it rather than on a new verb. Only `fresh` and `rebuild` carry a runtime change: a `fork` cannot cross harnesses, and a `discovered` successor gets no target startup or readiness check from the handover, so both are refused (review r2, F1). The CLI sends the spec's absolute path and content; the runtime-change options are refused without `--to-runtime`.

### Authority (D3) and attribution

- A runtime change is issued only by the kernel's operator seat, `operator.agent` in the unarchived rig named `kernel`, identified by the caller's transport identity (`X-OpenRig-Session`, provenance `transport:v1`). An absent header, `claimed:v1` or `origin-unknown:v1` is refused; the body's `--operator` is a label, never authority.
- `rig seat runtime-revert` may also be issued by the kernel's advisor seat (`advisor.lead`), and only to revert the node's most recent committed change. A forward change stays operator-only.
- `rig seat runtime-declare` is operator-only, like a forward change: the advisor may not run it.
- `--approval` records Christian's go verbatim, as attribution, not proof.
- **Security note:** the daemon has no caller authentication today. On a loopback daemon any local process can set the header, so the transport identity is attribution, not authentication; seat-environment and loopback-service exposure is a known estate issue (SEC-178).

### The spec of record (D2, Q1, Q5)

- `--spec` is required. Its `name` must equal the seat's rig, and its member at the seat's logical id must declare `runtime` = `--to-runtime`.
- **A non-kernel rig's spec is the source of truth:** the member must also declare `model` = `--to-model`, and every other value the change carries must be declared identically (`--to-cwd` against the resolved member cwd, `--to-env` against the member env, `--to-effort`). The successor takes cwd, env and effort from the spec, so a later `rig up` of that spec starts what runs.
- **On the kernel rig** the packaged variant (for example `rig-claude-only.yaml`) need declare only the runtime. Model, cwd and env come from the flags, and after the recorded change the node row is authoritative: a managed kernel never re-reads the builtin, restore relaunches from node rows, and installs rewrite only the packaged files. A cold boot of a missing kernel rig is a new identity. A first-start retry with the old builtin member is refused, never silently reverted.
- The ledger records the spec's path and the sha256 of the spec text the daemon parsed and validated. The CLI reads that text from the path; the daemon does not read the path itself.

### What a change carries and commits

| State | On commit |
|---|---|
| `nodes.runtime`, `nodes.model` | `--to-runtime`, `--to-model` |
| `nodes.cwd` | `--to-cwd`, the spec's member cwd (non-kernel), or unchanged |
| `nodes.env_json` (member env) | `--to-env` (replaces), the spec's member env (non-kernel), or unchanged |
| `nodes.effort`, `nodes.effort_choice` | the spec's effort (non-kernel) or `--to-effort` (kernel) |
| `nodes.codex_config_profile` | the spec's profile if the target is Codex, else cleared |
| `node_permission_selections` | `--to-permissions` for the target runtime, or deleted for `inherit` |
| `node_startup_context` | the target member's startup context (runtime = target) |
| Old `sessions` rows, new session and tenure | superseded; the new tenure records its runtime (`occupant_tenures.runtime`) |
| `node_runtime_changes`, `node_runtime_revert_slots` | a committed ledger row; the revert slot holds the state before the change |

- `--to-permissions` is always required: an inherited default is confirmed, never implied (D4). The dry run shows what `inherit` resolves to on the target runtime. Claude-native modes are set afterwards with the existing permissions verb.
- **Allow-list (review r2):** `--to-env` sets only names in `runtime.change_env_allowlist` (default `CLAUDE_CONFIG_DIR,CODEX_HOME`). With no caller authentication, an open list would let any local process pass `PATH`, `NODE_OPTIONS` or `LD_PRELOAD` to a `full_bypass` seat.
- **Secrets:** a `--to-env` name matching the estate's secret-name rule (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `CRED`, `PASSPHRASE`, `PRIVATE`, any case) is refused before any change. The ledger and the `seat.runtime_changed` event record env names with a sha256 of each value, never a value. `nodes.env_json` and the revert slot hold the values a launch needs.

### The target member's startup (Q4)

Before the successor launches, the handover resolves the `--spec` member the way a member launch does (the startup steps shared with `PodRigInstantiator.launchExistingAgentMember`). It then reconciles its skills, projects its resources and delivers its pre-launch files into the target cwd. After readiness it delivers the post-launch files, then the restore packet. The commit persists the target's startup context. The predecessor runtime's files (for example `AGENTS.md`, `.agents`, the `~/.codex/config.toml` hooks) are left in place and listed in the result.

### History and recap

The successor starts fresh: no native history crosses harnesses. The recap resolver reads the predecessor with the predecessor's runtime. The packet states the change first: "Runtime changed from codex to claude-code; the predecessor conversation is not resumed." The predecessor transcript stays reachable through the superseded session row and the tenure ledger.

### Failure, recovery and revert

1. **Preflight** (`--dry-run` stops here): authority, flags, the spec of record, the secret-name rule, the target adapter, and the target member's startup resolution. Every refusal precedes any change.
2. **Target startup:** skills, projection and pre-launch files, into the target cwd. A failure here changes nothing and the predecessor still runs.
3. **Cutover and verify:** the successor launches in the same pane with the target adapter, is ready, and receives its post-launch files and the packet.
4. **Commit:** one transaction for every row in the table above, plus the ledger row, the revert slot and the event.

- **Before the commit**, a failure leaves the node row, its startup context and the predecessor session untouched and records a `failed` ledger row with its code and step only; a launch failure's step includes the launcher's code. A change that throws rather than returning a failure records `threw_before_respawn` or `threw_after_respawn` at the step it reached, and the error still propagates. A change that has committed gets no failed row; any other error after a runtime change or revert committed returns `handover_committed_with_error` (Post-commit recovery, below), so a committed change is never relaunched or reverted to recover. Recovery keys on the ledger row, not on the result code: `runtime_change_target_startup_failed` and `runtime_revert_unavailable` also come from preparation and revert pre-checks that write no row, because nothing ran. If the activity oracle fails to take the swap after the commit landed, the result is `handover_committed_swap_undeclared` (HTTP 500; the CLI prints the code and exits non-zero): nothing is unwound, and the guidance says the change is committed, not to retry, relaunch or revert to recover, and to finish the declaration with `rig seat runtime-declare <seat>`. A failure at the target startup or at resolving the pane changes nothing: the predecessor still runs and no recovery is needed. If ending the retiree fails, the predecessor may have been signalled (TERM, then KILL) without being seen to exit, and its pane is left set to stay open: if it still runs, no recovery is needed; if it exited, recover as below. If the respawn is refused because the seat env allow-list could not be applied (`seat_env_refused`, spec 0013), the predecessor has ended and no successor started, and a relaunch is refused the same way: the guidance says to fix the seat env policy first (`rig config set seat_env.mode filter` rolls it back), then recover as below. After the respawn, the canonical session is live (and may hold the target runtime), so the recovery is `rig seat launch <seat> --fresh --stop`, which relaunches the seat under the runtime its node still records. The failure's guidance says which case applies.
- **After the commit**, `rig seat runtime-revert` restores the node's runtime, model, cwd, member env, effort, Codex profile, permission selection and startup context from the revert slot, and starts a fresh successor under the restored runtime in the same pane. `--resume-predecessor` resumes the predecessor's recorded conversation instead. A revert is recorded with `reverts_change_id`, clears the slot, and cannot itself be reverted.
- The successor's acceptance is recorded as `pending` on the ledger and the event; observing it is a follow-up (Notes).

### Post-commit recovery

- **The declaration marker (migration 116):** a committed ledger row carries `declared_at` and `declared_by`. The commit sets them, naming the change's operator, once the activity oracle takes the occupant swap, or at once on a daemon with no oracle. `rig seat runtime-declare` sets them, naming its caller. NULL on a committed row means the declaration is pending. Failed rows never carry them. Committed rows from before 116 are backfilled as declared by `before-116`: the restart that applies the migration empties the in-memory activity ladder, so no undeclared swap remains.
- **`rig seat runtime-declare <seat>`** finishes a pending declaration. It declares the seat's current occupant to the activity oracle (`declareOccupantSwap`, with the live session's id, as the commit does) and stamps the marker. It never relaunches, reverts or touches the pane. It reads the marker inside the node's lifecycle lease, and refuses unless the node's latest committed change is undeclared and its occupant generation is still the node's current one. After a daemon restart the ladder is empty, so a re-declare only stamps the marker.
- **Any other error after the commit** of a runtime change or revert is logged and returned as `handover_committed_with_error`, never as a failed handover.
- **Plain handovers** (no runtime change) have no ledger row: they get neither the command nor `handover_committed_with_error`, and their `handover_committed_swap_undeclared` guidance still says to report it (Not in this spec).

| Result code | HTTP | When | Ledger | Guidance, verbatim prefix |
|---|---|---|---|---|
| `handover_committed_swap_undeclared` | 500 | the oracle failed after the commit | one `committed` row, `declared_at` NULL | "The runtime change is COMMITTED: the seat runs `<runtime>` in "`<session>`". Do NOT retry, relaunch or revert to recover." It ends "Finish the declaration with: rig seat runtime-declare `<seat>`". |
| `handover_committed_with_error` | 500 | any other error after the commit | one `committed` row; `declared_at` set unless the oracle step had not run | "The runtime change is COMMITTED: the seat runs `<runtime>`. Do NOT retry, relaunch or revert to recover. If its occupant declaration is pending, finish it with: rig seat runtime-declare `<seat>` (it refuses when nothing is pending)." For a revert it says "runtime revert". |
| `runtime_declare_not_pending` | 409 | no committed change, already declared, or a later handover replaced its occupant | unchanged | "Nothing to declare. Inspect the seat with: rig seat status `<seat>`" |
| `runtime_declare_failed` | 500 | the oracle failed again | unchanged (`declared_at` NULL) | "The change stays COMMITTED. Do NOT relaunch or revert; retry: rig seat runtime-declare `<seat>`" |
| `runtime_change_unauthorized` | 403 | not the kernel operator's transport identity | unchanged | as for a runtime change |
| (success) | 200 | declared | `declared_at`, `declared_by` set | `{ seatRef, changeId, sessionId, declaredBy }` |

The CLI prints the code of `handover_committed_swap_undeclared`, `handover_committed_with_error` and `runtime_declare_failed` on its own line before the message and the guidance (`handover`, `runtime-revert` and `runtime-declare`), and exits 2 on a 500 and 1 on a 409.

## Requirements

- REQ-0005-01: The `rig seat handover` command shall accept `--to-runtime` naming the successor's runtime, with `--to-model`, `--to-permissions`, `--to-effort`, `--to-cwd`, `--to-env`, `--spec` and `--approval`.
- REQ-0005-02: If a runtime change is not issued by the kernel operator seat under a `transport:v1` identity, then the daemon shall refuse it before any change.
- REQ-0005-03: If a runtime change lacks `--to-model`, `--to-permissions`, `--spec` or `--approval`, then the handover shall refuse it before any change.
- REQ-0005-04: When a runtime change commits, the daemon shall keep the seat's node id, logical id, pod, rig, binding and canonical session name unchanged.
- REQ-0005-05: When a runtime change commits, the daemon shall write the node's runtime, model, cwd, member env, effort, Codex profile, permission selection and startup context in the same transaction as the new tenure.
- REQ-0005-06: The daemon shall write `nodes.runtime` only at node creation and in the commit of a runtime change or revert.
- REQ-0005-07: When a runtime change or revert commits, the daemon shall append a `node_runtime_changes` row with the from and to values, operator, approval, reason, spec path and sha256, and acceptance `pending`.
- REQ-0005-08: When a runtime change commits, the daemon shall record the target runtime on the new occupant tenure.
- REQ-0005-09: While a runtime change is in progress, the daemon shall leave queue rows addressed to the seat unchanged.
- REQ-0005-10: When a runtime change starts the successor, the handover shall deliver a recap packet that states the runtime change and that the predecessor conversation is not resumed.
- REQ-0005-11: When a runtime change builds its recap, the handover shall resolve the predecessor record with the predecessor's runtime.
- REQ-0005-12: If the target startup, the successor launch or its verification fails, then the daemon shall leave the node, its startup context and the predecessor session unchanged and record the attempt as failed.
- REQ-0005-13: If a fork source is given with `--to-runtime`, then the handover shall refuse and name `--source fresh` or `--source rebuild`.
- REQ-0005-14: If a discovered source is given with `--to-runtime`, whatever its runtime hint, then the handover shall refuse and name `--source fresh` or `--source rebuild`.
- REQ-0005-15: When `--dry-run` is given with `--to-runtime`, the handover shall print the transition, including what `inherit` resolves to, and change nothing.
- REQ-0005-16: The daemon shall commit a runtime change only after the target member's startup ran and the target adapter reports the successor ready.
- REQ-0005-17: If the `--spec` member does not declare `--to-runtime`, or on a non-kernel rig does not declare every value the change carries, then the handover shall refuse before any change.
- REQ-0005-18: If a `--to-env` name matches the secret-name rule, then the handover shall refuse before any change.
- REQ-0005-19: The ledger and the `seat.runtime_changed` event shall record member env as names with a sha256 of each value.
- REQ-0005-20: Before the successor launches, the handover shall reconcile the target member's skills, project its resources and deliver its pre-launch files into the target cwd.
- REQ-0005-21: When a runtime change commits, the result shall list the predecessor runtime's files left in place.
- REQ-0005-22: The `rig seat runtime-revert` command shall restore the node's most recent committed change from its revert slot and start a successor under the restored runtime.
- REQ-0005-23: If a revert is not issued by the kernel operator or advisor seat under a `transport:v1` identity, then the daemon shall refuse it.
- REQ-0005-24: If a seat has no recorded runtime change to revert, then `rig seat runtime-revert` shall refuse it.
- REQ-0005-25: Where `--resume-predecessor` is given, the revert shall resume the predecessor session's recorded token instead of starting a fresh successor.
- REQ-0005-26: If a `--to-env` name is not in `runtime.change_env_allowlist`, then the handover shall refuse before any change.
- REQ-0005-27: When the kernel's operator runs `rig seat runtime-declare` on a seat whose latest committed runtime change has a pending declaration and whose occupant is still current, the daemon shall declare that occupant to the activity oracle and record who declared it and when, without relaunching or reverting the seat.
- REQ-0005-28: If the seat's latest committed runtime change is absent, already declared or replaced by a later handover, then `rig seat runtime-declare` shall refuse with `runtime_declare_not_pending` and change nothing.
- REQ-0005-29: If an error occurs after a runtime change or revert has committed, then the handover shall return `handover_committed_with_error` with the committed-state guidance instead of a failed-handover error.

## Plan

1. **Spec and rulings** (this file).
2. **Extraction**, behaviour-preserving and its own commit: the member-startup steps of `launchExistingAgentMember` and the orchestrator's file partition become shared.
3. **Schema:** migration 115, `occupant_tenures.runtime` (backfilled), `node_runtime_changes` and `node_runtime_revert_slots`. The fork keeps its migration numbers clear of upstream's at each sync (upstream main has 114).
4. **Service, route and CLI:** preflight, target startup, the single-transaction commit, failure records, the revert and `seat.runtime_changed`.
5. **Tests**, then a scenario run on a scratch rig before any live seat is changed.

## Test

- **Real tmux, end to end** (`seat-runtime-change-e2e.test.ts`, isolated `-L` socket, stand-in adapters that type a stand-in command; this proves OpenRig's plumbing, not the real harnesses):
  - Codex to Claude Code: the same pane and name; node, tenure, startup context and ledger record the change; projection ran before the launch; the successor's cwd and `CLAUDE_CONFIG_DIR` are the target's; the ledger's env is a name and a hash; the old runtime's files are left and listed.
  - A successor that never becomes ready leaves the node, startup context and predecessor session unchanged and records a failed attempt.
  - The advisor reverts after a committed change; a second revert is refused. A revert with `--resume-predecessor` resumes the recorded token.
- **Refusals and dry run** (`seat-runtime-change.test.ts`): D3 for the operator, a non-kernel seat, `claimed:v1` and the advisor's forward change; missing approval, model or permissions; fork; secret-named env; D2 on non-kernel and kernel rigs; D4's dry run; a revert with nothing to revert.
- **Routes** (`seat-runtime-change-route.test.ts`) and **CLI** (`cli/test/seat.test.ts`): the transport identity reaches the service; status mapping; option forwarding.
- **Post-commit recovery** (`seat-runtime-revert-race.test.ts`, the route and CLI suites, `runtime-change-declared-migration.test.ts`): the marker at commit; a re-declare after an oracle failure, read back through the activity oracle's `lastSwap`; refusals when already declared, when nothing is committed, when a later handover replaced the occupant, and for no caller, the advisor and a relayed operator; `handover_committed_with_error` after a post-commit throw, and never after a returned pre-commit failure; the route's JSON 500s; the CLI's code line; the 116 backfill on an existing database.

## Notes

### Decisions (ruled 2026-10-18)

- **D1:** same node, a new occupant tenure, plus the runtime-change ledger.
- **D2:** the handover refuses unless the rig spec declares the target. Q1: `--spec` is required; persisting the spec path at `rig up` is a follow-up. Q5: on the kernel rig, the packaged variant need declare only the runtime and the node row is authoritative after the change.
- **D3:** only the kernel operator runs it, with Christian's go per change (`--approval`, attribution). Revert exception: the kernel advisor may revert the most recent change.
- **D4:** an inherited permission default is shown in the dry run and must be confirmed (`--to-permissions inherit`); `full_bypass` is an accepted explicit value.
- **D5:** the successor's acceptance is observed after commit. Q2: recorded as `pending`; the signal and the attention mark are a follow-up.
- **Q4:** a runtime change re-runs the target member's startup from `--spec`; the old runtime's files are left and listed.

### Not in this spec

- Persisting the rig spec path at `rig up` and reading it at handover (Q1 follow-up).
- The successor-acceptance signal and its attention mark (Q2 follow-up).
- Claude-native permission modes on a runtime change; cleaning up the predecessor runtime's files.
- Binding D3 to the daemon's managed-kernel record rather than to the rig name: while the real kernel rig is archived, a rig newly named `kernel` would authorize. No stable identifier survives a legitimate restart of the kernel from spec today, since that restart issues a new rig id (review r2, LOW).
- Post-commit recovery for plain handovers (no runtime change): a re-declare and a structured post-commit result need a marker that does not depend on the runtime-change ledger.
- Runtimes other than `codex` and `claude-code`, a pod-wide or rig-wide change, and the UI.

XERJ has no OpenRig index (checked 2026-10-18; a control query on the vilicus prefix answered). The references above are direct reads of `6d746c2a`.
