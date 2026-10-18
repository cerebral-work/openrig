---
status: complete
created: 2026-10-18
priority: low
scope: daemon, queue, cli, watchdog
author: ctodie
references: []
---

# 0011-park-blocker-row-lookup

## Overview

A parked queue row names its blocker in `blocked_on`. The daemon decided what a blocker was by its `qitem-` prefix.

**Completion wakes are fine.** A blocker's completion wakes any parked row (`propagateBlockerCompletion` matches `blocked_on` exactly), so a custom row id already wakes its parks.

**Two gaps came from the prefix:**
- (A) Only `qitem-` blockers were checked at park time for existence and liveness. A mistyped custom id, or one naming a row that is already done, was accepted as a "legacy gate name", and the park never lifted.
- (B) For a custom-id blocker:
  - the waiting projection showed the blocker's owner and state as null;
  - the park recorded no blocker wake;
  - a repeating wait did not watch the blocker's progress;
  - the stuck sweep verified a custom-id successor as if it were a seat.

**The motivating case:** a live park on 2026-10-18 named a custom row that was already done. That park could never lift.

**A smaller gap:** an unknown `<word>:` value such as `gate:time` was accepted silently.

## Design

1. `resolveParkBlocker` (`queue-repository.ts`) resolves a blocker by row lookup first.
   - **A value that is a queue row is that row,** whatever its prefix.
   - **Otherwise it is one of:**
     - a missing `qitem-` id;
     - a typed gate (`fold:`, `auth:`, `external:` with a body) or a malformed one;
     - a seat address, as the session-name parser reads it: `member@rig`, `member@rig@host` (a remote seat) or `<local>@external`;
     - an unknown `<word>:` prefix;
     - bare free text.
2. **Park validation, the CLI and agent path:**
   - The update route (`rig queue block`, `rig queue update --blocked-on`) sets `strictBlocker`.
   - **The accepted forms there:**
     - a live queue row (a `qitem-` id or an existing custom row id), which lifts the park when it resolves;
     - with a wake (`--wake-after <duration>` or `--wake-watchdog <jobId>`): a typed gate (`fold:<what>`, `auth:<what>`, `external:<what>`), or a seat address: `member@rig` naming a rig on this daemon, or `member@rig@host` for a remote seat;
     - a human seat (`human-<name>@kernel`) with `--summary` and `--evidence-ref` (the FR-6 park).
   - **How each blocker lifts, which decides the wake rule:**
     - Only a live row lifts a park by itself: `propagateBlockerCompletion` wakes every park whose `blocked_on` is the row's id.
     - Nothing on the daemon lifts `fold:`, `auth:` or `external:`, or a seat address. Park wakes are a watchdog, a timer or a blocker row.
     - So a park on one of these needs a wake, or it is refused (`blocker_wake_required`, with the accepted forms and an example).
     - An FR-6 human park is exempt: FR-6 requires its summary and evidence ref, and puts it on the human's attention surface. Any other human-looking ref (a host-qualified one, or `<local>@external`) is an address, and needs a wake.
   - **A two-part address must name a rig on this daemon.** It goes through the same check as a queue destination, so `waiting@later` is refused (`blocker_not_found`). A three-part `member@rig@host` is accepted as a remote seat.
   - Bare free text, an unknown prefix, a missing `qitem-` id and a row that is not live are refused (`blocker_not_found`, `blocker_unknown_prefix`, `blocker_not_live`).
   - Each error keeps the existing message as its prefix (a missing `qitem-` id still points at `external:<host>/<id>` for a row on another host). It then lists the accepted forms and says that a free-text human wait uses `external:<name>`.
3. **Park validation, closures the daemon writes in-process:**
   - Workflow closures and gate parks (`workflow-projector.ts`) and mission-control closures keep their authored gate names. They are accepted with a warning, because nothing resolves such a name.
   - A missing `qitem-` id and a dead `qitem-` row are refused on every path, as before.
4. **Existing parks are not rewritten.** A park that names no blocker keeps one with a warning instead of a refusal; so does a park naming the blocker the row already carries. With no blocker named, the park restores the row's own blocker or the gate a claim retained. None of the CLI form rules above refuses it.
   - **Exception:** a gate restored from a claim (the row no longer carries it) still needs a wake, unless it is a live row. The claim ended that park and its wake, so without one the restored park would have nothing to lift it (review W1). A still-parked re-park keeps its existing wake, and an FR-6 human park is unaffected.
5. **The same row lookup everywhere the prefix gated behaviour:**
   - the park's blocker wake;
   - the waiting projection's blocker owner and state;
   - the repeating wait's blocker progress (`queue-wait-backoff.ts`);
   - the stuck sweep's closure targets: a custom-id successor row is custody, and is verified with `rig queue show`.
6. **`rig queue block --help`** lists the blocker forms (the typed prefixes from `TYPED_GATE_BLOCKER_PREFIXES`) and what is refused. It shows a time-only park: `--on external:<what> --wake-after <dur> --continuation '...'`.
7. **`rig watchdog list`:**
   - It labels a park-generated timer with `parkTimer: { oneShot, serves }`, naming the row it serves and whether it fires once. A plain park timer goes terminal with `park_timer_fired_once`; a repeating queue wait does not.
   - So a long park timer no longer reads as a recurring job.
   - `serves` names only rows whose current park still uses the timer (`findCurrentQitemsByGeneratedTimer`), never a row that has resumed.
8. **Not in scope:** calendar-time wakes (`--until <time>`).

## Requirements

- REQ-0011-01: When the daemon resolves a park's blocker, it shall look the value up as a queue row before it reads the value's prefix.
- REQ-0011-02: If a park from the update route names bare free text, an unknown prefix or a row that is not live, then the daemon shall refuse it.
- REQ-0011-11: When the daemon refuses a park from the update route on bare free text, an unknown prefix, a missing qitem- id or a row that is not live, the refusal shall list the accepted blocker forms.
- REQ-0011-03: When a closure the daemon writes in-process parks a row on an authored gate name, the daemon shall accept it with a warning.
- REQ-0011-04: If a row is re-parked with no blocker named or on the blocker value it already carries, then the daemon shall keep that blocker instead of refusing it.
- REQ-0011-05: When a park's blocker is a queue row, the daemon shall record a blocker wake for that row.
- REQ-0011-06: When a parked row's blocker is a queue row, the waiting projection shall show that row's owner and state.
- REQ-0011-07: When a repeating wait names a blocker that is a queue row, the wait shall track that row's progress.
- REQ-0011-08: When a closure is handed off to an existing custom row id, the stuck sweep shall treat it as custody, not a dangling closure.
- REQ-0011-09: The `rig queue block` help shall list the typed gate prefixes and show a time-only park.
- REQ-0011-10: When `rig watchdog list` shows a park-generated timer, it shall name the row the timer serves and whether it fires once.
- REQ-0011-12: If a park from the update route names a two-part seat address whose rig is not on this daemon, then the daemon shall refuse it.
- REQ-0011-13: If a park from the update route names a typed gate or a seat address and carries no wake, then the daemon shall refuse it.
- REQ-0011-14: When `rig watchdog list` names the rows a park timer serves, it shall name only rows whose current park uses that timer.
- REQ-0011-15: If a park from the update route restores a gate a claim retained and carries no wake, then the daemon shall refuse it unless the gate is a live row.

## Plan

1. Fork PR `fix/blocker-row-lookup`.
2. **Existing parks:** a read-only count through the daemon API on 2026-10-18 found 34 live parks:
   - 14 on typed gates and 12 on `qitem-` rows;
   - 2 on seat addresses;
   - 5 on custom row ids (4 live rows, 1 done row);
   - 1 on the unknown prefix `gate:time`.

   None is rewritten. A new park from the CLI on the done custom row or on `gate:time` would now be refused.

## Test

```bash
cd packages/daemon && npx vitest run test/queue-blocker-row-lookup.test.ts test/queue-stuck-sweep.test.ts test/queue-blocker-refusal-shape.test.ts test/workflow-exception-stuck.test.ts test/waiting-backstop.test.ts test/queue-list-delivery-ledger.test.ts
cd packages/cli && npx vitest run test/queue.test.ts test/queue-update-metadata-reject-cli.test.ts test/watchdog.test.ts
```

**What the new tests cover:**
- a custom-id park on a live row (it validates, projects owner and state, and records a blocker wake);
- on the CLI path, a terminal custom row (the motivating case), bare free text and an unknown prefix are refused with the accepted forms, while in-process closures keep them;
- a missing `qitem-` id is refused on every path;
- typed gates and addresses are unchanged;
- a re-park on the existing value is warned, not refused;
- the update route is the strict path;
- a repeating wait on a custom row watches it;
- the sweep verifies a custom-id successor as a row;
- the refusals list the accepted forms after any original message;
- the watchdog list's park-timer label, through the real app factory, and in the CLI's compact view, plain and `--json`;
- the block help text;
- a two-part address on an unknown rig is refused, while a known one and a three-part remote seat are accepted;
- a typed gate or address without a wake is refused on the CLI path, but accepted with a wake or in-process; a live row needs no wake;
- an FR-6 human park is refused without its fields, and accepted with them, needing no wake;
- `rig watchdog list` doesn't name a resumed row as served;
- a claimed row re-blocked with no blocker named keeps its retained gate (`queue-claim-blocker`). A typed gate needs a wake for that: without one it is refused, with one it is restored. A restored live row needs none;
- end to end through the real CLI, loopback HTTP and the real route and repository (`queue-update-metadata-reject-cli`): `rig queue block` and `rig queue update --blocked-on` refuse bare free text and an unknown prefix with the accepted forms, refuse a done custom row, and accept a live one.

Each fix, broken on purpose once, turns its test red. The existing suites that park on authored names or human addresses stay green.
