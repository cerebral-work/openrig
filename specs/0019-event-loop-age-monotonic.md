---
status: in-progress
created: 2026-10-24
priority: high
scope: daemon, event-loop health, daemon status guard
author: fork-maintainers
references: [CER-3096]
---

# 0019-event-loop-age-monotonic

## Overview

`EventLoopMonitor` (`packages/daemon/src/domain/event-loop-monitor.ts`) measured the age of its last tick on the wall clock. It set `lastTickAt` from `Date.now()` and computed `lastTickAgeMs = Date.now() - lastTickAt`.

**What a forward wall-clock step did:** a step of one second or more pushed `lastTickAgeMs` past `LAST_TICK_STALE_MS` (1000). `evaluateEventLoopHealthy` then returned false until the next 250 ms tick, and for that window the daemon status guard refused every `rig` command, read-only ones included, with "Daemon did not respond".

**On one WSL2 guest:**
- the wall clock was measured stepping forward about 3.58 s every 35.8 s, while `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` stayed smooth;
- every `rig` call issued within about 250 ms of a step failed;
- a client polling every 5 s logged 97 such failures in 24 h, each between 9 ms and 263 ms after a logged step.

A backward step was already harmless, because of `Math.max(0, …)`.

## Design

- **The age is measured on the monotonic clock.** The monitor already held `monotonicNow` (default `performance.now()`) and refreshed `monotonicTick` on every tick. `lastTickAgeMs` is now `max(0, monotonicNow() - monotonicTick)`.
- **The wall clock is removed from the monitor.** The `now` option and the `lastTickAt` field go. Nothing in production passed `now`; tests inject `monotonicNow`.
- **`onTick(at, previous)`** already passed monotonic values. Unchanged.
- **The snapshot shape is unchanged.** Only the meaning of `lastTickAgeMs` changes, from wall time to monotonic time, and the doc comment says so.

## Requirements

- REQ-0019-01: `EventLoopMonitor.snapshot().lastTickAgeMs` shall equal the monotonic time elapsed since the last recorded tick, never less than 0.
- REQ-0019-02: A forward wall-clock step with no monotonic stall shall leave `snapshot().healthy` true.
- REQ-0019-03: A backward wall-clock step shall leave `lastTickAgeMs` equal to the monotonic time elapsed.
- REQ-0019-04: A monotonic stall of `LAST_TICK_STALE_MS` or more with no tick shall make `snapshot().healthy` false, as before.
- REQ-0019-05: `EventLoopMonitor` shall not read `Date.now()` to compute any health input.

## Plan

1. Write the tests first. They step the real `Date.now` (`vi.spyOn`) and prove red against the unfixed monitor.
2. Change the age computation and remove the wall-clock option and field.
3. Update the existing tests that injected `now` to inject `monotonicNow`.

## Test

```bash
cd packages/daemon && npx vitest run test/event-loop-monitor.test.ts test/request-phase-observer.test.ts test/event-loop-health-server.test.ts
```

- **REQ-0019-01 and 04:** `reports rising last-tick age and flips healthy=false past the stale threshold`, driven by an injected `monotonicNow`.
- **REQ-0019-02 and 05:** `a forward wall-clock step with no monotonic stall stays healthy` (Date.now +3600 ms, monotonic +250 ms).
- **REQ-0019-03:** `a backward wall-clock step leaves the age measured on the monotonic clock`.
- **Red-first:** with the unfixed `event-loop-monitor.ts` from main swapped in, these three tests fail; with the fix restored, all 8 tests in the file pass.

## Notes

**Out of scope here** (separate follow-ups):
- **Seat activity staleness.** `seat-activity-service` and `seat-structural-activity-service` compare a wall `now()` with wall timestamps parsed from activity events (5 s structural staleness, 15 s hook-authority window). A forward step can flip `agentActivity` for a few seconds. Those inputs are wall timestamps from external events, so a monotonic fix needs a design of its own.
- **Other `Date.now()` deadlines** in `transcript-rotation` and `session-transport`. A step can expire them early.
- **Transient "running but not ready" in `rig ps`.** No wall-clock age feeds `startupStatus`. The likely source is a transient identity verdict (`mismatch`) projected as `attention_required` until the next 5 s sweep. Not a clock defect; to be confirmed with a captured `rig ps --json` during an event.
