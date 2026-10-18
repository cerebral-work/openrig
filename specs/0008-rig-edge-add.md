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

## Design

1. `POST /api/rigs/:rigId/edges` with `{ from, to, kind }`, where `from` and `to` are logical ids (`pod.member`), handled by `domain/rig-edge-add.ts` `addRigEdge`.
2. The rig must exist (404 `rig_not_found`) and be unarchived (409 `rig_archived`). Both logical ids must be nodes of that rig (400 `node_not_found`). The kind must be in `VALID_EDGE_KINDS` (400 `invalid_kind`). A missing field is 400 `validation_failed`. Every rejection comes before any write.
3. A new edge is one row through `RigRepository.addEdge` (201 `created`). An identical existing edge is returned as it is (200 `exists`), and nothing is written.
4. No node, session or binding changes, so the rig ID and every seat's conversation are kept.
5. Authorization is the same as `rig expand` and `rig add`: the `/api/*` `browserBoundary` in `server.ts`, which checks the target name, the browser Origin, and the bearer token for non-loopback access.
6. CLI: `rig edge add <rig-id> <from> <to> --kind <kind> [--json]`, registered after `expand`.
7. Docs: `docs/reference/rig-spec.md` ("Edges on a running rig"), the `rig expand` help and the capability map describe `crossPodEdges` and `rig edge add`.
8. Runtime effect: `delegates_to` is read live by `queue-owner.ts` and by the `edges` in `rig whoami`. `can_observe` is recorded and shown, but no runtime behaviour reads it yet.

## Requirements

- REQ-0008-01: When `rig edge add` names two nodes of an unarchived rig and a valid kind, the daemon shall insert exactly one edge row between them.
- REQ-0008-02: The edge add shall leave every node, session and binding of the rig unchanged.
- REQ-0008-03: If an identical edge already exists, then the daemon shall return that edge without writing.
- REQ-0008-04: If either logical id is not a node of the rig, then the daemon shall reject the request before any write.
- REQ-0008-05: If the kind is not a valid edge kind, then the daemon shall reject the request before any write.
- REQ-0008-06: If the rig is archived, then the daemon shall reject the request before any write.
- REQ-0008-07: The `rig expand` help shall document the fragment's `crossPodEdges` key.

## Plan

1. Implemented on `feat/factory-expansion-fixes`, after cw.4.1.
2. After install (operator): add the cortex factory edges, `delegates_to` from `orch.lead` to `dev.build`, `dev.design`, `dev.qa`, `review.r1` and `review.r2`, and `can_observe` from `review.r1` and `review.r2` to `dev.build`, `dev.design` and `dev.qa`. Check them with `rig whoami`.
3. Candidate upstream PR (`up/` branch), since the gap exists upstream.

## Test

```bash
cd packages/daemon && npx vitest run test/rig-edge-add-route.test.ts test/rig-expansion-route.test.ts
cd packages/cli && npx vitest run test/edge.test.ts test/lazy-program.test.ts test/expand.test.ts
```

Route cases: created, row counts unchanged apart from edges, idempotent repeat, rejections (unknown node, another rig's node, bad kind, missing field), 404 for an unknown rig, 409 for an archived rig, and whoami showing the edge at once. CLI cases: the request body, created, exists, error exit 1, and `--json`.
