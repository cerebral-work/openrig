---
status: in-progress
created: 2026-10-26
priority: high
scope: daemon, server, ps-projection
author: ctodie
references: [CER-3089, cortex-edge]
---

# 0021-aggregate-inventory-and-stopped-rig-quiescence

## Overview

On hosts with 15+ registered rigs, `rig ps --nodes -A --json` sequentially queries `/api/rigs/:rigId/nodes` per rig, taking 4.7s and causing `cortex-edge` 2s discovery timeouts. Additionally, stopped rigs continued to project `periodicSnapshotActive: true` in `ps-projection.ts` because `this.periodicSnapshotActive` is a daemon-wide flag rather than gated on rig lifecycle and running seat count.

## Design

1. **Aggregate `/inventory` HTTP Endpoint (`server.ts`):**
   - Exposes `GET /inventory`, `GET /api/inventory`, and `GET /api/nodes` backed by `getNodeInventoryForAllRigs(deps.rigRepo.db)`.
   - Stamps `hostSelfId: getSelfHostId()` on every returned node row to preserve multi-host roster attribution (`REQ-0047-11` / Slice 13 fix 2).
2. **Stopped-Rig Snapshot Quiescence (`ps-projection.ts`):**
   - Projects `periodicSnapshotActive: this.periodicSnapshotActive && lifecycleState !== "stopped" && effectiveRunningCount > 0` so stopped or zero-agent rigs report `periodicSnapshotActive: false`.

## Requirements

- REQ-0021-01: When a client requests `/inventory`, `/api/inventory`, or `/api/nodes`, the daemon shall return the aggregate node inventory across all rigs in a single response.
- REQ-0021-02: The daemon shall stamp `hostSelfId` from `getSelfHostId()` on every node row returned by the aggregate inventory routes.
- REQ-0021-03: While a rig has `lifecycleState === "stopped"` or `effectiveRunningCount === 0`, the ps projection shall report `periodicSnapshotActive` as `false`.

## Plan

1. Add `/inventory`, `/api/inventory`, and `/api/nodes` routes in `packages/daemon/src/server.ts`.
2. Gate `periodicSnapshotActive` in `packages/daemon/src/domain/ps-projection.ts` on `lifecycleState !== "stopped" && effectiveRunningCount > 0`.

## Test

```bash
npx vitest run packages/daemon/test/slice13-host-attribution-resume-type.test.ts
```
