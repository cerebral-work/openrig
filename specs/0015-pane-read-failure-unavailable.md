---
status: in-progress
created: 2026-10-18
priority: high
scope: daemon, tmux, seat identity
author: ctodie
references: [orch-lead@cortex qitem-20261018090719-4f384704b5be0d44, cw.4.2]
---

# 0015-pane-read-failure-unavailable

## Overview

orch-lead@cortex found every enrolled OpenRig seat dropping off the cortex mesh at once, about every 20–40 minutes, on cw.3 and cw.4. Caught at 08:43:42Z on 2026-10-18:
- `rig ps` exited 0 with every running seat at `startupStatus: attention_required`;
- cortex-edge then bound 0 seats, and the brain deregistered all 33 panes.

Mechanism at cerebral b6847523:
1. `rig ps` projects a running seat as `attention_required` when `identityVerdictDownranksRunning` holds (`types.ts:628`), that is, for a `mismatch` or `pane_missing` verdict (`node-inventory.ts:227`).
2. The fleet identity sweep (`seat-identity-reconciler.ts`) reads all panes in one batch. A failed batch read (`TmuxAdapter.readAllPaneProcesses` returns null) becomes an empty map, so every pane is read on its own.
3. `TmuxAdapter.getPanePid` returns `null` for **any** failure: a timeout, a server error, or the pane really being gone.
4. `computeVerdict` turned a `null` pid into `pane_missing`, reason `pane_pid_gone`. A transient tmux failure under load therefore down-ranked every running seat at once.
   - The selection pass also cached a failed read as `{ pid: null }`, which `computeVerdict` then took as a pane gone.
5. A failed `listSessions` was already handled as `tmux_unavailable`. The pane-pid path had no equivalent.

Two more writers turned a failed tmux read into a down-rank:
- the tokenless Claude sole-pane recheck: a failed `listPanes` or pid read gave `mismatch` / `process_identity_ambiguous`, as reproduced;
- the rebind proof (`rebindAndVerifyPaneIdentity`): after a listing that showed the pane, a failed pid read wrote `pane_missing`.

## Design

1. **A typed pane-pid read.**
   - `TmuxAdapter.observePanePid` returns:
     - `{ kind: "pid" }`;
     - `{ kind: "absent" }`, only when tmux's own stderr says it can't find the pane (`isPaneAbsenceError` on `tmuxReportedError`, so pane output on stdout never classifies);
       - tmux 3.4, the version on ceres, answers `display-message -p -t <gone pane>` with **exit 0 and an empty reply**, on both the argv and control-mode transports.
       - An empty reply for a pane-id target (`%N`) is therefore confirmed with `list-panes -t <pane> -F '#{pane_id}'`, which reports "can't find pane" for a gone pane.
       - A session target (`=name:`, which `getPanePid`'s other callers pass) is never confirmed. Its absence reads "can't find session", which is never a pane's, so those callers make no extra call.
       - Absent only on that report. A pane it still lists, or any other failure of that read, is `unavailable` (review r1 F1 on #18; orch-lead ruling, r1's option (b)).
     - `{ kind: "unavailable" }` for anything else, including a timeout, another exit or an unreadable reply.
   - `getPanePid` delegates to it and keeps its `number | null` meaning for its other callers.
   - `readPanePid` reads through `observePanePid` when an adapter has it. An adapter without it keeps its own meaning (null = gone); in production only `TmuxAdapter` implements pane reads.
2. **`pane_missing` needs positive evidence.** In the fleet sweep, a pane is gone only in one of two cases:
   - tmux reports it gone: "can't find pane" from `display-message`, or, on tmux 3.4, from the confirming `list-panes -t`. That covers a killed pane in a live session, and a stale pane id after a session was recreated under the same name.
   - its session is absent from the successful `listSessions`.

   A failed read of a pane in a live session gives the unavailable verdict.
   - A failed batch read lists nothing, so each pane is decided by its own read; the selection cache marks a failed read `unavailable`.
   - The tokenless sole-pane recheck gives the unavailable verdict when its `listPanes` or pid read fails.
   - The rebind proof reports "tmux pane identity lookup failed" and records no verdict when the pid of the pane its listing showed can't be read.
3. **The cross-runtime rule, as built.** On a failed read:
   - **`claude-code` and `terminal`:** verdict `tmux_unavailable`. It is not down-ranked (`types.ts` "fail-open on unknown", OPR.0.4.3.19), so the seat keeps its stored status.
   - **`codex`:** upstream's tmux-unavailable rule applies: verdict `mismatch`, reason `tmux_unavailable` (6553aaef, pinned by `seat-identity-reconciler.test.ts` "cannot verify an unavailable pane").
     - A Codex seat's failed pid read used to give `pane_missing` / `pane_pid_gone`; it now gives that rule's `mismatch` / `tmux_unavailable`. Both are down-ranked, but `restore-check`'s remediation text differs.
     - **Known gap:** a Codex seat still flaps on a tmux failure. No Codex seat runs on ceres today.
     - orch-lead's ruling (2026-10-18) keeps upstream's fail-closed rule here and files the Codex choice as its own follow-up: the last verdict through a bounded outage, a uniform `tmux_unavailable`, or upstream.
   - **Shapes tested** (the claims here go no further):
     - a terminal seat, a direct Claude seat, and a Claude seat with a resume token, each under a total failure and a mixed one;
     - a managed Claude seat (wrapper shell and resume token, the dominant production shape) under a total failure;
     - the tokenless wrapped Claude recheck;
     - the rebind proof.
   - **Known residual, not in this change:** a managed Claude seat under an **intermittent** blip still gets `mismatch` / `process_identity_ambiguous`, which down-ranks it. That happens when `ps` fails once, or one native-proof sample's pid read fails. Native proof is fail-closed. orch-lead files it with the Codex rule as one follow-up: a bounded last-verdict hold through transient proof failures. (Probed at da94bf2e.)
4. **Consumers of a down-ranking verdict** (`pane_missing`, `pane_pid_gone` and `mismatch`), read-only audit at b6847523. A down-ranked running seat projects `startupStatus` and `lifecycleState` `attention_required` (`node-inventory`), and the rig rolls up `attention_required`.
   - **Acting consumers:**
     - **`rig archive`** refused without `--force` only while the rig was `running`/`degraded`, read from that projection. A flap therefore let it archive a rig with live seats without `--force`. **Fixed here:** the guard reads stored liveness. A stored-running seat counts as `attention_required` only on a confirmed `session_missing`, stored startup attention, or restore attention/failed, never on a pane-read verdict (orch-lead ruling (b), 2026-10-18). Upstream's "healthy plus confirmed-missing archives without force" stays.
     - **Workflow role resolution** (`workflow-role-resolver.ts:122`) disqualifies a seat that is not `running` (`not_live(lifecycleState=attention_required)`), so routing to a role skips a down-ranked seat. **Unchanged, by ruling:** skipping an identity-unverified seat for routing is defensible.
   - **The attention gate:** `seat-attention-reconciler`'s `getActiveIdentityVerdict` raises the pane-identity attention class only on `mismatch` or `pane_missing` (`:607-617`). Clearing that attention runs the rebind (`:343-353`). It is a projection gate, not an automatic action. This is why a gone pane must still read `pane_missing`: otherwise nothing prompts the rebind.
   - **Projections and reports, no action:**
     - `rig ps` (`node-inventory`), `graph-projection`, `ps-projection`, `seat-status-service`;
     - the provider read model (`provider-collect`, which hides non-running Claude seats);
     - `restore-check` (red, with `remediationSafe: false`).
   - **Not affected:** `kernel-boot-tracker`, which reads the stored `startup_status`.
   - Outside OpenRig, cortex-edge reads `rig ps` and deregisters the seats.
   - Scope: the modules that read the identity verdict or the projected `lifecycleState`/`startupStatus`, found by searching for the verdict names and for `=== "running"`/`"ready"` filters.

## Requirements

- REQ-0015-01: The tmux adapter shall report a pane as absent only when tmux's own error output says it cannot find the pane.
- REQ-0015-02: When a pane pid read fails for any other reason, the seat identity reconciler shall record the unavailable verdict for a seat whose session is listed live.
- REQ-0015-03: If a batched pane read fails, then the seat identity reconciler shall decide each pane from its own read.
- REQ-0015-04: When the tokenless Claude sole-pane recheck cannot read tmux, the seat identity reconciler shall record the unavailable verdict instead of a mismatch.
- REQ-0015-05: When the rebind proof cannot read the pid of the pane its listing showed, the attention reconciler shall report the lookup failure without recording a verdict.
- REQ-0015-06: While a stored running seat has no confirmed missing session and no stored startup or restore attention, the archive route shall count it as live.

## Plan

1. Fork branch `fix/pane-pid-unavailable` from `cerebral` b6847523; a PR on hold, for cw.4.2.
2. Not built here (orch-lead's follow-up): the Codex unavailable rule. The cortex-edge defence (treat an all-seats skip as a failed discovery) is cortex's own slice.

## Test

```bash
cd packages/daemon && npx vitest run test/tmux-pane-pid-failure.test.ts test/tmux-pane-pid-native.test.ts
cd packages/daemon && npx vitest run test/rigs-routes.test.ts -t "force|archive"
```

- **Adapter:**
  - a pid;
  - tmux's "can't find pane" is absent;
  - a timeout, another exit, and "can't find pane" only on stdout are unavailable;
  - `getPanePid` is unchanged.
- **Fleet sweep:** the real `TmuxAdapter` runs over scripted tmux output, with a terminal seat, a direct Claude seat and a Claude seat with a resume token.
  - A timeout, and a non-zero exit, on the batch and every pane read: every seat is `tmux_unavailable` and none is down-ranked.
  - A gone pane is still `pane_missing`.
  - Mixed (the batch fails; one pane reads, one is gone, one fails): `verified`, `pane_missing` and `tmux_unavailable`.
  - A managed Claude seat (wrapper shell, resume token) whose every read fails is `tmux_unavailable`.
  - Codex keeps upstream's `mismatch` / `tmux_unavailable`.
- **Recheck:** a failed `listPanes` or pid read is unavailable, not `process_identity_ambiguous`.
- **Rebind:** a failed read writes no `pane_missing`; tmux's "can't find pane" still does.
- **Native, real tmux** (`tmux-pane-pid-native.test.ts`): a private `TMUX_TMPDIR` server (never the user's), over the argv and control-mode transports.
  - `observePanePid` gives a pid for a live pane, and `absent` for a killed pane, a stale id and a never-existing pane.
  - The fleet sweep gives `pane_missing` / `pane_pid_gone` for a killed pane in a live session (terminal and Claude) and for a stale pane id; a healthy seat is `verified`.
  - Base 071dca1d: the sweep gives `pane_missing` (green). 46a45a8b: red (`tmux_unavailable`). With the fix: green.
- **The scripted tmux in the unit tests models tmux 3.4:** an empty `display-message` reply for a gone pane, and `list-panes -t` reporting the absence. It no longer throws on `display-message`, which hid F1.
- **Archive** (`rigs-routes.test.ts`): running seats down-ranked by `pane_missing`/`pane_pid_gone`, `mismatch`/`process_identity_ambiguous`, or Codex `mismatch`/`tmux_unavailable` are refused without `--force` (409) and archive with it. The upstream healthy-plus-confirmed-missing case still archives without `--force`.
- **Red first:** every new case except the 3 controls fails on its base:
  - 12 of 15 on b6847523;
  - the managed-seat case on 79e11a4f (`pane_pid_gone`);
  - the 3 archive cases (200 instead of 409).
- **Break-once:** each of 11 guards was broken and shown red:
  - failures taken as absent;
  - classifying on stdout;
  - the verdict guard;
  - the cache mark;
  - both recheck guards;
  - the rebind guard;
  - the archive guard reading the projected lifecycle again;
  - no confirming read;
  - an empty reply taken as absent unconfirmed;
  - any failure of the confirming read taken as absent.
