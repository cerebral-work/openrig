---
status: complete
created: 2026-10-18
priority: low
scope: daemon, workflow, docs
author: ctodie
references: []
---

# 0010-workflow-human-gate-targets

## Overview

A workflow gate targets a human seat session or a declared role. The human seat form is `HUMAN_SEAT_SESSION_PATTERN`, `/^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/` (`human-route-enforcer.ts`). The cortex factory used `ctodie@host` and `ctodie@external`, got `gate_target_unresolved`, and bound its release gate to `advisor-lead@kernel` through a role as an interim. The per-person seat `human-ctodie@kernel` was valid all along. A row parked on it reaches the person through the attention surface and the Mission Control approve path. The error named only "human@kernel form".

## Design

1. `human-route-enforcer.ts` adds `GATE_TARGET_FORMS` (every accepted form: `human@kernel`, `human@host`, `human-<name>@kernel`, `human-<name>@host`, or a declared role) and `gateTargetHint`. The hint flags a `<name>@external` target as a gateway (Slack) address and suggests `human-<name>@kernel` for any `<name>@...` target. The check is lexical, so the validator stays pure.
2. The `gate_target_unresolved` messages in `workflow-validator.ts` (author time) and `workflow-projector.ts` (gate compile) use both.
3. The capability map documents the gate-target forms under `rig workflow validate`.
4. Not changed: the gate-target grammar, `isHumanPark` and `validateHumanPark`. Binding gates to registry humans is a public-contract change, recorded upstream as a candidate (CER-2905).

## Requirements

- REQ-0010-01: If a gate target is neither a human seat session nor a declared role, then the validator shall name every accepted gate-target form in its error.
- REQ-0010-02: If an unresolved gate target is an `@external` address, then the validator shall say that it is a gateway address, not a gate target.
- REQ-0010-03: If an unresolved gate target has the form `<name>@<anything>`, then the validator shall suggest `human-<name>@kernel`.
- REQ-0010-04: The validator shall accept `human-<name>@kernel` and `human@host` as gate targets, as before.

## Plan

1. Implemented on `feat/factory-expansion-fixes`, after 0009 and 0008.
2. After install (operator, on the lead's word): rebind the factories' release gates from the interim `advisor-lead@kernel` role to `human-ctodie@kernel`.

## Test

```bash
cd packages/daemon && npx vitest run test/workflow-wf2-spec-language.test.ts test/workflow-validator.test.ts
```

New cases:
- `ctodie@external`: the message names the forms (including `human@host`), flags the gateway address and suggests `"human-ctodie@kernel"`;
- `ctodie@host`: the message suggests `"human-ctodie@kernel"` and does not mention a gateway;
- `human-ctodie@kernel` and `human@host` validate (control).
