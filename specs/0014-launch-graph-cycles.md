---
status: in-progress
created: 2026-10-18
priority: high
scope: daemon, restore, topology growth
author: ctodie
references: [CER-2976, PR #12 review r1]
---

# 0014-launch-graph-cycles

## Overview

Review r1 of fork PR #12 found that a rig whose launch-dependency edges form a cycle restores **silently short**.
- `computeRestorePlan` (`restore-orchestrator.ts`) sorts seats topologically with no cycle check.
- A seat that never reaches in-degree 0 is left out of the plan, and restore still returns `ok: true`.
- r1 reproduced it at 9c8b93dc with two shapes:
  - a reverse `delegates_to` edge between orch.lead and dev.build: only dev.qa was launched;
  - a dev.qa self-edge: dev.qa was skipped.
- A host reboot or `rig start` loses those seats with no error.

Since #12, `rig edge add` refuses such edges with the shared `computeLaunchOrder`. Three other paths could still store a cycle, or restore an old one:
- **Rigs stored before #12** (or written by any other route) restore through the unchecked planner.
- **Growing an existing rig** checks only the new spec. `computePodLaunchOrder` skips any edge with an end outside the one-pod spec, so these were written unchecked:
  - `rig expand` cross-pod edges;
  - `add_member` pod-local edges that name existing pod-mates.
  - Reproduced on b6847523: a fragment with cross-pod edges both ways between a new and an existing seat was accepted `ok` (`test/rig-growth-graph-cycle.test.ts`, red at base).
- **Materialize-only creating a rig** (`POST /api/rigs/import/materialize` with no target rig, reached by `rig import --materialize-only` and `rig adopt`) wrote the spec's edges with no cycle check.
  - The schema refuses only self-edges, and `computePodLaunchOrder` runs only in instantiate and at launch.
  - Review r1 found it on #17: a pod-local two-seat cycle was stored (201) while `rig import` refused the same spec (400).

Launch dependency, as in the spec path and `rig edge add`: `delegates_to` launches its source first; `spawned_by` launches its target first.

## Design

1. **Restore holds a seat it cannot order; it never drops one.**
   - Every seat the plan can order launches, as before.
   - Each seat in a cycle, or behind one, gets its own node result:
     - status `awaiting-decision`;
     - error `restore_graph_cycle: <edges>; no session was started; remove one of these edges with: rig edge remove <rigId> <from> <to> --kind <kind>, then restore.`
     - The recovery is the same one a growth refusal gives (`removeCycleEdgeHint`), naming `rig edge remove` (CER-2981, spec 0008). Until that command existed it read "There is no edge-removal command yet: rig remove <rigId> <seat> drops a seat together with its edges."
   - `<edges>` are the stored edges (`source kind target`, logical ids) of every cycle at or upstream of that seat, sorted. An unrelated cycle is not named.
   - `awaiting-decision` and not `attention_required`, per orch-lead's ruling (2026-10-18), because the restore vocabulary (`types.ts` `RestoreNodeResult`) reserves:
     - `attention_required` for a live session parked on a prompt;
     - `awaiting-decision` for "no session was started", which is also how restore already reports its other such cases.
   - The held results are part of the rig rollup, so the restore reports `partially_restored`. A rig whose every seat is held also reports `partially_restored`, not an empty `failed`.
2. **Every materialize write is checked against the whole graph before anything is written.**
   - `materializeValidatedSpec` serves every guarded path:
     - with a target rig: `rig expand`, `add_member`, and the materialize route with `X-Target-Rig-Id`;
     - with no target: materialize-only creating a rig.
   - It runs `computeLaunchOrder`, the check `rig edge add` uses, over the target rig's seats and edges (none when it creates a rig) plus the spec's. Edges naming a seat that is neither are left to the existing missing-node refusal.
   - A cycle is refused before the write transaction, with code `cycle_error`. The message names the cycle edges and says nothing was written.
   - The expand, add-member and materialize routes return it as 400 (each mapping has a route test).
   - The refusal names the cycle's edges and says how to recover:
     - **The cycle uses an edge from the request:** leave one of the new edges out and retry.
     - **The cycle is entirely existing edges:** like `rig edge add`, a rig that already holds a cycle refuses any growth. The refusal ends with the same recovery as the restore reason: "Remove one of these edges with: rig edge remove <rigId> <from> <to> --kind <kind>, then retry."
   - The live database had no such rig on 2026-10-18: a read-only copy, scanned with this detector, showed 0 of 34 rigs holding a cycle.
3. **`rig import` (instantiate) is unchanged.** It already refused cycles: `computePodLaunchOrder` runs before `createRig`.
   - A launch-kind self-edge is refused as a cycle on every path. The legacy schema refuses all self-edges (`rigspec-schema.ts`).
   - The pod-aware schema stores a non-launch self-edge (for example `can_observe a -> a`): review r1's probe3 on #17. Such an edge doesn't affect launch order or restore.
4. `heldByLaunchCycles` (`launch-graph-cycles.ts`) is a pure helper. It finds the seats no order can place and the cycle edges at or upstream of each, and both the restore reason and the growth refusal use it. Restore keeps its own ordering. The helper only names edges for the seats that ordering left out, so no seat can be dropped even if the two disagreed.

## Requirements

- REQ-0014-01: When a restore's launch-dependency graph leaves a seat unordered, the restore orchestrator shall report that seat as `awaiting-decision` with a `restore_graph_cycle` reason naming the stored cycle edges at or upstream of it.
- REQ-0014-02: The restore orchestrator shall include every seat of the intended roster in the restore result.
- REQ-0014-03: While a held seat is reported, the restore orchestrator shall start no session for it.
- REQ-0014-04: When a materialize write would make the rig's launch-dependency graph cyclic, the pod instantiator shall refuse with `cycle_error` before writing any rig, node, pod or edge.
- REQ-0014-05: The pod instantiator shall name the cycle's edges, stored or requested, in a `cycle_error` refusal.
- REQ-0014-06: When a restore holds a seat or a growth refusal names a stored cycle, the message shall name `rig edge remove` with the rig's id as the recovery.

## Plan

1. Fork branch `fix/restore-graph-cycle` from `cerebral` b6847523; a PR on hold.
2. `rig edge remove` was built afterwards (CER-2981, spec 0008), and the restore reason and the growth refusal now name it.

## Test

```bash
cd packages/daemon && npx vitest run test/restore-graph-cycle.test.ts test/rig-growth-graph-cycle.test.ts
cd packages/daemon && npx vitest run test/rig-expansion-route.test.ts -t "launch-order cycle"
```

- **Restore** (`restore-graph-cycle.test.ts`):
  - an acyclic control;
  - a self-edge;
  - a two-seat `delegates_to` cycle with a seat behind it;
  - a `spawned_by` cycle;
  - an all-held rig (`partially_restored`);
  - a seat behind one cycle that names only that cycle.
  - Every case checks that the result covers every seat, the held seats' status, and the exact named edges.
- **Growth** (`rig-growth-graph-cycle.test.ts`):
  - a one-way control;
  - expand with cross-pod edges both ways;
  - expand closing a cycle through an existing edge;
  - `add_member` closing a cycle with pod-mates;
  - an already-cyclic rig refusing unrelated growth.
  - Every refusal checks `cycle_error`, the named edges, and an unchanged rig (seats, edges, pods).
- **Routes:**
  - expand with a cycle returns 400 `cycle_error`;
  - materialize-only with no target refuses a pod-local cycle (400) and stores no rig (r1 F1, red on 3aff2881);
  - add-member (r1's case E) and materialize with a target (r1's case F) return 400 `cycle_error` and write nothing.
- **Red first:** every case above except the controls fails on b6847523.
- **Break-once:** each guard was broken and shown red:
  - the held results not pushed;
  - pushed after the rollup;
  - every cycle named instead of the upstream ones;
  - the growth guard removed;
  - the route's 400 mapping removed;
  - either recovery text forced;
  - the recovery sentence dropped from the restore reason or from the refusal.
  - the guard skipped when creating a rig, and either route mapping removed (add-member, materialize).
