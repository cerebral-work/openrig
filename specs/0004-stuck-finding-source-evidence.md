---
status: complete
created: 2026-10-18
priority: high
scope: daemon, queue
author: ctodie
references: []
---

# 0004-stuck-finding-source-evidence

## Overview

Retro spec for fork PR #4 (merged 2026-10-17 into `cerebral` after cw.3, shipped in `0.6.10-cw.4`). Before it, a retry marker removed a source row from the stuck sweep's candidates and closed its open recovery finding even while the source stayed pending and undelivered, and the closure was credited to the source seat. As implemented at `cerebral` `6d746c2a` (`packages/daemon/src/domain/queue-stuck-sweep.ts`).

## Design

1. **Resolution needs source evidence.** While its source row is pending, in progress or blocked, an open `undelivered-wake` finding closes only when that row is claimed in progress, its last wake result is `verified`, or a human notification was posted in the current episode. An `unclaimed-obligation` finding on a still-pending, unclaimed source closes only on that human post. A source in a terminal state closes its finding (`queue-stuck-sweep.ts:644`). A missing source row is not evidence.
2. **Attribution.** Sweep closures are made by `stuck-sweep@system`, with `no-follow-on` and a transition note that records the source state, claim, wake result and human post.
3. **Suppression lease.** A retry or escalation marker suppresses new findings for at most 30 minutes (`STUCK_SWEEP_LADDER_MAX_AGE_MINUTES`). Expiry only restores reporting: it never retries transport, drives a prompt or changes ladder scheduling. Invalid or future timestamps do not suppress.
4. **Stall age (CER-2984).** A `stalled-after-claim` finding reports its age from the anchor `derivePickup` measured the stall from: `PickupReceipt.stalledSince`, the latest of the claim, the last meaningful queue change and a post-claim heartbeat. It never reports from the first claim. The claim's age is shown beside it (`claimed: M min ago`; summary `(stalled N min, claimed M min ago)`).
   - **When a stall fires is unchanged:** the threshold, the owner-activity rule and what counts as a meaningful change stay as they were.
   - **Before this:** a row claimed at 06:30Z, parked, and resumed at 12:48Z read `383 min` at 12:53Z for a 4-minute stall.

## Requirements

- REQ-0004-01: If a stuck finding's source row is missing, then the sweep shall leave the finding open.
- REQ-0004-02: While an `undelivered-wake` source is pending, in progress or blocked without a claim, a verified wake or a human post, the sweep shall leave its finding open.
- REQ-0004-03: While an `unclaimed-obligation` source is pending and unclaimed with no human post, the sweep shall leave its finding open.
- REQ-0004-04: When the sweep closes a finding, it shall record the closure as `stuck-sweep@system` with the source evidence in the transition note.
- REQ-0004-05: The sweep shall let a retry or escalation marker suppress new findings for no more than 30 minutes.
- REQ-0004-06: If a marker timestamp is invalid or in the future, then the sweep shall not suppress reporting.
- REQ-0004-07: When the sweep reports a `stalled-after-claim` finding, it shall give the stall age from the pickup receipt's `stalledSince`, not from the row's first claim.
- REQ-0004-08: When the sweep reports a `stalled-after-claim` finding, it shall show the claim's age separately from the stall age.

## Plan

Implemented in fork PR #4 (`29d5363e`; `e0db88be` after the cw.4 rebase). No release bump or historical queue repair was part of it.

CER-2984 (cw.4.3) adds item 4 and REQ-0004-07 and -08:
- `PickupReceipt.stalledSince` and `StalledPickupFinding.stalledSince`;
- the sweep's age, its `claimed:` line and its summary.

The new receipt field is additive: it appears in every queue show and list JSON while a row is stalled.

## Test

```bash
cd packages/daemon && npx vitest run test/queue-stuck-sweep.test.ts test/queue-wake-ladder.test.ts test/queue-pickup.test.ts
```

PR #4 recorded 13 cases failing on the original code and 80 passing sweep cases after the fix; fork CI runs these suites. At `6d746c2a` the two suites pass 137 cases.
