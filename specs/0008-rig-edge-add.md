---
status: complete
created: 2026-10-18
priority: medium
scope: daemon, cli, topology
author: ctodie
references: []
---

# 0008-rig-edge-add

## Overview

A rig expanded after `rig up` could not gain edges between seats that already exist. The cortex factory (rig `01M55MGC8973G7FRHW9P7EZT9F`) lacks its template's `delegates_to` edges from the lead to the five added seats, and the reviewers' `can_observe` edges to the dev seats. `rig expand` accepts cross-pod edges for the pod it adds, through a fragment key, `crossPodEdges:`, that no doc mentioned (`cli/src/commands/expand.ts`). `rig add` qualifies both ends with its own pod (`rigspec-instantiator.ts` `addMemberToPod`). No verb added an edge between two existing nodes.


`rig edge remove` (CER-2981) is the reverse. Since spec 0014, a rig whose edge graph holds a launch-order cycle refuses any growth, and restore holds the cycle's seats, but no command removed an edge. The only recovery was `rig remove <rigId> <seat>`, which drops a whole seat.
## Design

1. `POST /api/rigs/:rigId/edges` with `{ from, to, kind }`, where `from` and `to` are logical ids (`pod.member`), handled by `domain/rig-edge-add.ts` `addRigEdge`.
2. The rig must exist (404 `rig_not_found`) and be unarchived (409 `rig_archived`). Both logical ids must be nodes of that rig (400 `node_not_found`). The kind must be in `VALID_EDGE_KINDS` (400 `invalid_kind`). A missing field is 400 `validation_failed`. Every rejection comes before any write.
3. A new edge is one row through `RigRepository.addEdge` (201 `created`). An identical existing edge is returned as it is (200 `exists`), and nothing is written.
   - **Audit (CER-3001):** in the same transaction as the insert, a `rig.edge_added` event records `{ rigId, edgeId, from, to, kind, by }`, shaped like `rig.edge_removed` (item 11). `by` is the caller's transport identity (`X-OpenRig-Session`) with its recorded provenance, `{ session, provenance }` (`relay:v1` when relayed), or null when absent: attribution, not authentication. Subscribers are notified after the commit. A repeat (`exists`) and every rejection write no event, because no row is written.
   - Like the spec path (`rigspec-schema.ts` validation and the instantiator's launch order), it refuses a self-edge of any kind (400 `self_edge`). It also refuses a `delegates_to` or `spawned_by` edge that would close a launch-order cycle (400 `cycle`), both before any write.
   - The cycle check is the spec path's own `computeLaunchOrder`, now exported from `rigspec-instantiator.ts`, run over the rig's stored edges plus the new one. Restore plans from those stored edges and drops the nodes of a cycle (review r1), so the refusal keeps every node restorable.
   - Order of checks: rig, archive, kind, nodes, self-edge, existing edge, cycle. A repeat of an existing edge stays a 200 `exists`.
4. No node, session or binding changes, so the rig ID and every seat's conversation are kept.
5. Authorization is the same as `rig expand` and `rig add`: the `/api/*` `browserBoundary` in `server.ts`, which checks the target name, the browser Origin, and the bearer token for non-loopback access.
6. CLI: `rig edge add <rig-id> <from> <to> --kind <kind> [--json]`, registered after `expand`.
7. Docs: `docs/reference/rig-spec.md` ("Edges on a running rig"), the `rig expand` help and the capability map describe `crossPodEdges` and `rig edge add`.
8. Runtime effect: `delegates_to` is read live by `queue-owner.ts` and by the `edges` in `rig whoami`. `can_observe` is recorded and shown, but no runtime behaviour reads it yet.

### Removing an edge (CER-2981)

9. **The route:** `DELETE /api/rigs/:rigId/edges?from=<logical id>&to=<logical id>&kind=<kind>`, handled by `domain/rig-edge-add.ts` `removeRigEdge`. The edge is named by the same three values `rig edge add` takes. A missing parameter is 400 `validation_failed`.
10. **Checks, in the add's order, every rejection before any write:**
    - the rig exists (404 `rig_not_found`) and is unarchived (409 `rig_archived`);
    - the kind is valid (400 `invalid_kind`);
    - both logical ids are nodes of the rig (400 `node_not_found`);
    - the edge exists (404 `edge_not_found`). Removing an absent edge is never reported as success.
11. **The write:** an edge's identity to the operator is (from, to, kind), and the edges table allows duplicate rows, so every row matching it is deleted (the lead's ruling on review r1). In the same transaction, one `rig.edge_removed` event per deleted row records `{ rigId, edgeId, from, to, kind, by }`. `by` is the caller's transport identity (`X-OpenRig-Session`) with its recorded provenance, `{ session, provenance }` (`relay:v1` when relayed), or null when absent: attribution, not authentication. The result is 200 `{ ok: true, status: "removed", edges }`, one entry per deleted row; the CLI adds `(<n> duplicate rows)` when there were several. A row another caller deleted between the read and the write is skipped with no event; if none remains, the result is `edge_not_found`. That `rig expand` can store a duplicated pod edge twice is a separate defect.
12. **What it never touches:** no node, session, binding or pane changes, so the rig ID and every seat's conversation are kept.
13. **No validity rule applies.** Edges are optional and only shape-checked, and removing one cannot create a cycle. Removing a cycle edge lets the rig grow again and lets restore launch the seats it held.
14. **Runtime effect:** a removed `delegates_to` edge stops counting for `queue-owner.ts` routing and `rig whoami` at once.
15. **Authorization** is the same as `rig edge add`: the `/api/*` `browserBoundary`. The add records `rig.edge_added` (item 3, CER-3001) and the remove `rig.edge_removed`, so both directions are audited the same way.
16. **CLI:** `rig edge remove <rig-id> <from> <to> --kind <kind> [--json]`.

### At most one row per edge (CER-3002)

17. **The rule.** An edge's identity is (rig, source, target, kind), and the edges table holds at most one row for each. Before CER-3002 the table had no unique constraint, and every path that stores edges inserted each listed entry. So an expand fragment, a `rig add` member or a rig spec that listed an edge twice stored it twice.
18. **Every insert path:** `RigRepository.addEdge` returns the stored edge when an identical one exists and writes no row. That one choke point covers expand, `rig add`, `rig up` and `instantiate` alike. A duplicate entry is collapsed, not refused, as `rig edge add` already answers a repeat with `exists`.
19. **Migration `900_edges_unique`** cleans up existing databases, in one migration transaction:
    - it records one `rig.edge_removed` event for every duplicate row except the earliest of each group, the earliest being the lowest rowid, i.e. insertion order. Each event carries `{ rigId, edgeId, from, to, kind, by }` with `by = { session: "migration 900_edges_unique", provenance: "migration" }`;
    - it deletes those rows;
    - it creates the unique index `idx_edges_unique` on `(rig_id, source_id, target_id, kind)`.
20. **Migration numbering in the fork.** Fork-only migrations take numbers 900 to 999 from CER-3002 on, so they never collide with upstream's sequence. Upstream was at 114 on 2026-10-18 and will continue at 115 and up.
    - The fork's earlier 115 and 116 keep their numbers: databases record applied migrations by name, so renaming them would re-run them.
    - `migrate.ts` sorts migrations by name and applies every one not yet recorded, so 900 runs after every 1xx.
    - An upstream migration that rebuilds the `edges` table would drop the index, so check at each upstream sync.
21. **Rollback to cw.4.3** (a binary without 900, on a database where it ran):
    - **Startup:** `migrate.ts` ignores recorded migrations it doesn't know, so the binary starts normally and the unique index stays.
    - **Insert paths:** cw.4.3's `addEdge` has no duplicate check. A duplicate listed entry then fails on the index (`SQLITE_CONSTRAINT_UNIQUE`):
      - in materialize (expand, `rig add`) and `instantiate`, the transaction rolls back and the request fails, instead of storing a duplicate;
      - in `instantiateOnce` (`rig up`) the best-effort catch skips the duplicate;
      - `rig edge add` checks for the stored edge first and is unaffected.
    - **No restore:** a rollback does not bring back the duplicate rows 900 removed; their `rig.edge_removed` events record them. Docs: `docs/reference/rig-spec.md` and the capability map describe it.

## Requirements

- REQ-0008-01: When `rig edge add` names two nodes of an unarchived rig and a valid kind, the daemon shall insert exactly one edge row between them.
- REQ-0008-02: The edge add shall leave every node, session and binding of the rig unchanged.
- REQ-0008-03: If an identical edge already exists, then the daemon shall return that edge without writing.
- REQ-0008-04: If either logical id is not a node of the rig, then the daemon shall reject the request before any write.
- REQ-0008-05: If the kind is not a valid edge kind, then the daemon shall reject the request before any write.
- REQ-0008-06: If the rig is archived, then the daemon shall reject the request before any write.
- REQ-0008-07: The `rig expand` help shall document the fragment's `crossPodEdges` key.
- REQ-0008-08: If `from` and `to` name the same node, then the daemon shall reject the request with `self_edge` before any write.
- REQ-0008-09: If a `delegates_to` or `spawned_by` edge would close a launch-order cycle, then the daemon shall reject the request with `cycle` before any write.
- REQ-0008-10: When `rig edge remove` names an existing edge of an unarchived rig by its two logical ids and kind, the daemon shall delete every edge row matching them and record one `rig.edge_removed` event per deleted row, naming that row, the caller's transport identity and its provenance.
- REQ-0008-11: The edge removal shall leave every node, session, binding and pane of the rig unchanged.
- REQ-0008-12: If no edge of the rig matches the two logical ids and the kind, then the daemon shall reject the removal with `edge_not_found` and write nothing.
- REQ-0008-13: If the rig is archived, the kind is invalid, or either logical id is not a node of the rig, then the daemon shall reject the removal before any write.
- REQ-0008-14: When `rig edge add` inserts an edge, the daemon shall record a `rig.edge_added` event naming the edge, the caller's transport identity and its provenance, in the same transaction as the insert.
- REQ-0008-15: If `rig edge add` writes no edge row (an existing edge, or a rejection), then the daemon shall record no `rig.edge_added` event.
- REQ-0008-16: When any path stores an edge identical in rig, source, target and kind to a stored edge, the daemon shall keep the stored edge and write no row.
- REQ-0008-17: When migration `900_edges_unique` runs, it shall delete every duplicate edge row except the earliest of its group, and record one `rig.edge_removed` event for each deleted row, before adding a unique index on (rig, source, target, kind).
- REQ-0008-18: The daemon shall number fork-only migrations from 900 to 999.

## Plan

1. Implemented on `feat/factory-expansion-fixes`, after cw.4.1.
2. After install (operator): add the cortex factory edges, `delegates_to` from `orch.lead` to `dev.build`, `dev.design`, `dev.qa`, `review.r1` and `review.r2`, and `can_observe` from `review.r1` and `review.r2` to `dev.build`, `dev.design` and `dev.qa`. Check them with `rig whoami`.
3. Candidate upstream PR (`up/` branch), since the gap exists upstream.

## Test

```bash
cd packages/daemon && npx vitest run test/rig-edge-add-route.test.ts test/rig-expansion-route.test.ts
cd packages/cli && npx vitest run test/edge.test.ts test/lazy-program.test.ts test/expand.test.ts
```

Duplicates (CER-3002): `rig-growth-graph-cycle.test.ts` (an expand whose fragment lists a pod-local edge, and a cross-pod edge, twice stores each once) and `edges-unique-migration.test.ts` (`addEdge` returns the stored edge; a database at 116 with duplicate groups: the earliest row of each kept, one event per removed row, the index refuses a duplicate; and a binary without 900 still migrates that database).

Audit (CER-3001): `rig-edge-add-route.test.ts` (an add records `rig.edge_added` with the edge and the caller's identity, a relayed caller as `relay:v1`, no caller as null; a repeat and a rejection record none; an insert that fails leaves no event and no row).

Removal (CER-2981): `rig-edge-add-route.test.ts` (the DELETE route: removed with its event and the caller's identity, a relayed caller, a wrong kind or the reverse direction as 404 while the edge exists, duplicate rows all removed with one event each, an already-removed edge as 404, a row gone before the write as 404 with no event, the rejections, a cross-site request refused), `rig-growth-graph-cycle.test.ts` (after removing a cycle edge the rig grows again), `restore-graph-cycle.test.ts` (the held seat's reason names `rig edge remove` with the rig's id; after removing a cycle edge restore launches every seat it held) and `cli/test/edge.test.ts` (`rig edge remove`).

Route cases: created, row counts unchanged apart from edges, idempotent repeat, rejections (unknown node, another rig's node, bad kind, missing field, a self-edge of any kind, a `delegates_to` or `spawned_by` edge closing a cycle, while a `can_observe` edge back is accepted), 404 for an unknown rig, 409 for an archived rig, and whoami showing the edge at once. CLI cases: the request body, created, exists, error exit 1, and `--json`.
