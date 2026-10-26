---
status: in-progress
created: 2026-10-26
priority: medium
scope: daemon, plugin vendor service, global rigs skill
author: fork-maintainers
references: []
---

# 0020-vendor-version-prerelease

## Overview

At startup the daemon installs the person-facing `rigs` skill into the harness skill folders under its own version (`packages/daemon/src/startup.ts`). `PluginVendorService.ensureSkillDirGlobally` accepts only a plain `x.y.z` version. A fork build's version has a pre-release part (`0.6.10-cw.4.5`, `0.7.2-cw.1-rc.1`), so the service refused it. Startup then logged `global rigs skill setup warning: [plugin-vendor] invalid version '0.6.10-cw.4.5' at rigs source; expected numeric x.y.z authority` on every boot, and the `rigs` skill was never installed or refreshed on a fork daemon.

**Measured on the live cw.4.5 daemon (2026-10-26):** the warning was in its recent log 20 times.

## Design

- **A helper takes the numeric core.** `vendorAuthorityVersion(raw)` in `plugin-vendor-service.ts` returns the `x.y.z` part of `x.y.z-<pre-release>`.
- **Any other input is returned as it came.** `unknown`, `0.7`, `v0.7.2` and `0.7.2.1` still reach the service and are refused there.
- **Only the call site changes.** `startup.ts` passes `vendorAuthorityVersion(getDaemonVersion())`. The service's own check stays strict.
- **Consequence:** two fork builds with the same `x.y.z` (for example cw.1 and cw.2) share one vendor version, so a later cw build does not refresh a `rigs` skill that an earlier one installed. The skill comes from upstream and changes with `x.y.z`.

## Requirements

- REQ-0020-01: When the daemon version is `x.y.z` followed by a pre-release part, the daemon shall install the `rigs` skill under the version `x.y.z`.
- REQ-0020-02: If the daemon version is not `x.y.z` with an optional pre-release part, then the daemon shall pass it unchanged to the vendor service, which refuses it.
- REQ-0020-03: The vendor service shall keep refusing any version that is not plain `x.y.z`.

## Plan

1. Write the helper's test first and see it fail.
2. Add the helper and use it at the call site.
3. Break the helper once and see the test fail.

## Test

```bash
cd packages/daemon && npx vitest run test/plugin-vendor-authority-version.test.ts test/plugin-vendor-service.test.ts
```

- **REQ-0020-01:** `takes the numeric core of 0.7.2-cw.1-rc.1` and four more inputs.
- **REQ-0020-02 and 03:** `leaves "unknown" unchanged, so the service still refuses it` and five more inputs; `plugin-vendor-service.test.ts` keeps its `invalid version 'unknown'` case.
- **Red-first:** with the helper returning its input, 4 of the 11 tests fail; with it restored all 11 pass.

## Notes

**Out of scope:** a fork `rigs` skill refresh on every cw build. That needs the vendor service to order pre-release versions.
