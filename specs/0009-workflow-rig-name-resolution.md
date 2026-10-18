---
status: complete
created: 2026-10-18
priority: high
scope: daemon, workflow
author: ctodie
references: []
---

# 0009-workflow-rig-name-resolution

## Overview

Workflow code resolved a bound rig by name to the OLDEST rig of that name, archived or not (`SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1`). Every lead swap archives a rig and creates a new one under the same name. On 2026-10-18 the rigs table held three rigs named `cortex`, two of them archived with only `orch.lead`. So `rig workflow instantiate` flagged the five added cortex seats as "NO member of that rig has this coordinate" while `rig ps` showed them, and dynamic role resolution could pick seats from an archived rig.

## Design

1. `workflow-role-context.ts` `resolveUnarchivedRigId` resolves a name through `RigRepository.findUnarchivedRigsByName`, the archive-aware lookup seat refs already use (#174). Its callers are `candidatesForRig` (role resolution), `rigMemberExists` (the member advisory) and `rigDeclaresRole` (role coverage at instantiate).
2. Exactly one unarchived rig of the name is the bound rig. Two or more throw `RigNameAmbiguousError`, naming their ids; nothing is picked.
3. Instantiate (`workflow-runtime.ts`): rig registration and the registered-rig list count only unarchived rigs. Binding, by `--rig` or the spec default, fails with `rig_ambiguous`. The member sweep reports an ambiguous rig as a `rig_ambiguous` advisory instead of skipping it.
4. Projection (`workflow-projector.ts` `resolveRoleOnBoundRig`) fails with `rig_ambiguous`.
5. Exception routing (`tryResolveRoleByCapability`) treats an ambiguous name as no capability match, so the exception goes to the human fallback and no rig is picked.
6. No unarchived rig of the name keeps today's outcomes (`bound_rig_not_found`, or not registered).
7. Second site, the same class (revenant's reported gap 2):
   - `whoami-service.ts` resolves a session name only among sessions of unarchived rigs. Two or more live rigs throw `WhoamiAmbiguousError`, which carries their ids.
   - `rig queue whoami` sends the seat's `OPENRIG_NODE_ID` when the session is the seat's own. The queue route uses that node only when its current session is the caller's.
   - The route reports `rig_ambiguous`, naming the rigs, instead of `calling node unavailable`.
8. One condition, one code: `rig_ambiguous` is the code `rig add` already returns when more than one unarchived rig has a name, so fix A and the whoami site use it too, with the candidate rig ids in the message.
9. Every other rig-by-name lookup in `packages/daemon/src` (review r1 sweep, `findRigsByName` and `FROM rigs WHERE name`):
   - Fixed here, the same class (an archived rig chosen or counted as the rig):
     - `routes/queue.ts` `validateTargetRepo` (create, handoff, handoff-and-complete) took the oldest same-name rig's workspace. It now reads the one unarchived rig's workspace; two or more give 400 `rig_ambiguous` with their ids.
     - `rig-mode/operating-posture.ts` rig identity matched an archived same-name rig too, so a reused name was "ambiguous" and the posture fell to unknown. Matching by id is unchanged; matching by name counts unarchived rigs only.
   - Already archive-aware: `bundle-install-context.ts`, `routes/up.ts` (prefers unarchived, falls back to archived by design).
   - Every same-name rig by design (no pick): `running-name-guard.ts` (a running session anywhere blocks the name), `session-transport.ts` `resolveByRig` and the session search (collect from all same-name rigs).
   - Follow-up, out of scope: `ask-service.ts` and `routes/down.ts` `isUniqueName` count archived rigs as rivals; `routes/startup.ts` treats an archived `kernel` as one to reuse; `startup.ts` rig-registered treats an archived-only name as registered; `routes/activity.ts` takes an unordered match. `rig add` already refuses a shared live name with `rig_ambiguous`.

## Requirements

- REQ-0009-01: When workflow code resolves a bound rig by name, the daemon shall consider only unarchived rigs.
- REQ-0009-02: When exactly one unarchived rig has the name, the member advisory shall check that rig's nodes.
- REQ-0009-03: When exactly one unarchived rig has the name, role resolution shall draw its candidates from that rig.
- REQ-0009-04: If two or more unarchived rigs share the name, then binding and projection shall fail with `rig_ambiguous` naming their ids.
- REQ-0009-05: If two or more unarchived rigs share a rig name in a preferred target, then the instantiate member sweep shall report `rig_ambiguous` as an advisory.
- REQ-0009-06: The rig-registered check shall ignore archived rigs.
- REQ-0009-07: When whoami resolves a session name, the daemon shall consider only sessions of unarchived rigs.
- REQ-0009-08: If a session name resolves to two or more live rigs, then `rig queue whoami` shall report `rig_ambiguous` naming those rigs.
- REQ-0009-09: When `rig queue whoami` runs with the seat's own session, the CLI shall send the seat's node id.
- REQ-0009-10: When a queue item names a target repo, the daemon shall validate it against the workspace of the one unarchived rig named by the source session.
- REQ-0009-11: When operating posture resolves a rig by name, the daemon shall consider only unarchived rigs.

## Plan

1. Implemented on `feat/factory-expansion-fixes`; it is the first of its three changes.
2. After install: re-run `rig workflow validate` on the cortex factory spec. The five "NO member" advisories are gone.

## Test

```bash
cd packages/daemon && npx vitest run test/workflow-member-advisory.test.ts test/workflow-role-resolution.test.ts test/workflow-human-destination.test.ts test/role-orientation.test.ts
cd packages/daemon && npx vitest run test/queue-target-repo-unarchived.test.ts test/queue-cross-host-target-repo.test.ts test/queue-cross-host-handoff.test.ts test/operating-posture.test.ts
cd packages/cli && npx vitest run test/queue.test.ts
```

New cases:
- an archived older `cortex` and a live one: the probe reads the live rig, and instantiate is silent;
- role resolution picks the live rig's seats, not `dev-plannerold@factory-a`, which it picked before the fix;
- two live same-name rigs give `rig_ambiguous` at instantiate, mid-run at projection, and in the advisory.

The read-fault fixture in `workflow-human-destination.test.ts` now faults the new lookup's SQL.

Second-site cases (`role-orientation.test.ts`):
- revenant's shape, two archived rigs and one live rig sharing `orch-lead@revenant`: queue whoami resolves the live node's role. Before the fix it said `calling node unavailable`.
- two live rigs give `rig_ambiguous` naming both;
- the caller's node id disambiguates its own session only.

The CLI sends `nodeId` with a defaulted session and not with an explicit `--session`.

Sweep cases:
- `target_repo`: an archived `rig-a` with `repo-old` and a live `rig-a` with `repo-new`: `repo-new` is accepted and `repo-old` refused. Before the fix the archived rig's workspace was read. Two live `rig-a` rigs give `rig_ambiguous`.
- posture: an archived `demo` beside the live one resolves the live rig's posture (it was unknown); two live `demo` rigs stay unknown.
