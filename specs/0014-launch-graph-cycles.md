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

Since #12, `rig edge add` refuses such edges with the shared `computeLaunchOrder`. Two other paths could still store a cycle, or restore an old one:
- **Rigs stored before #12** (or written by any other route) restore through the unchecked planner.
- **Growing an existing rig** checks only the new spec. `computePodLaunchOrder` skips any edge with an end outside the one-pod spec, so these were written unchecked:
  - `rig expand` cross-pod edges;
  - `add_member` pod-local edges that name existing pod-mates.
  - Reproduced on b6847523: a fragment with cross-pod edges both ways between a new and an existing seat was accepted `ok` (`test/rig-growth-graph-cycle.test.ts`, red at base).

Launch dependency, as in the spec path and `rig edge add`: `delegates_to` launches its source first; `spawned_by` launches its target first.

## Design

1. **Restore holds a seat it cannot order; it never drops one.**
   - Every seat the plan can order launches, as before.
   - Each seat in a cycle, or behind one, gets its own node result:
     - status `awaiting-decision`;
     - error `restore_graph_cycle: <edges>; no session was started; remove one of these edges, then restore`.
   - `<edges>` are the stored edges (`source kind target`, logical ids) of every cycle at or upstream of that seat, sorted. An unrelated cycle is not named.
   - `awaiting-decision` and not `attention_required`, per orch-lead's ruling (2026-10-18), because the restore vocabulary (`types.ts` `RestoreNodeResult`) reserves:
     - `attention_required` for a live session parked on a prompt;
     - `awaiting-decision` for "no session was started", which is also how restore already reports its other such cases.
   - The held results are part of the rig rollup, so the restore reports `partially_restored`. A rig whose every seat is held also reports `partially_restored`, not an empty `failed`.
2. **Growing an existing rig is checked against its whole graph before anything is written.**
   - `materializeValidatedSpec` with a target rig serves `rig expand`, `add_member`, and the materialize route with `X-Target-Rig-Id`.
   - It runs `computeLaunchOrder`, the check `rig edge add` uses, over the rig's seats and edges plus the spec's. Edges naming a seat that is neither are left to the existing missing-node refusal.
   - A cycle is refused before the write transaction, with code `cycle_error`. The message names the cycle edges and says nothing was written.
   - The expand, add-member and materialize routes return it as 400.
   - Like `rig edge add`, a rig that already holds a cycle refuses any growth until an edge is removed. The refusal names the existing edges.
3. **The spec path is unchanged.** It already refuses self-edges and cycles (`rigspec-schema.ts`, `computePodLaunchOrder`).
4. `heldByLaunchCycles` (`launch-graph-cycles.ts`) is a pure helper. It finds the seats no order can place and the cycle edges at or upstream of each, and both the restore reason and the growth refusal use it. Restore keeps its own ordering. The helper only names edges for the seats that ordering left out, so no seat can be dropped even if the two disagreed.

## Requirements

- REQ-0014-01: When a restore's launch-dependency graph leaves a seat unordered, the restore orchestrator shall report that seat as `awaiting-decision` with a `restore_graph_cycle` reason naming the stored cycle edges at or upstream of it.
- REQ-0014-02: The restore orchestrator shall include every seat of the intended roster in the restore result.
- REQ-0014-03: While a held seat is reported, the restore orchestrator shall start no session for it.
- REQ-0014-04: When growing an existing rig would make its launch-dependency graph cyclic, the pod instantiator shall refuse with `cycle_error` before writing any node, pod or edge.
- REQ-0014-05: The pod instantiator shall name the cycle's stored edges in a `cycle_error` refusal.

## Plan

1. Fork branch `fix/restore-graph-cycle` from `cerebral` b6847523; a PR on hold.
2. Not built here: a route or CLI to remove one edge (today only spec re-import or direct repair can remove one).

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
- **Route:** expand with a cycle returns 400 `cycle_error`.
- **Red first:** every case above except the controls fails on b6847523.
- **Break-once:** each guard was broken and shown red:
  - the held results not pushed;
  - pushed after the rollup;
  - every cycle named instead of the upstream ones;
  - the growth guard removed.
