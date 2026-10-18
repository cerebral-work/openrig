---
status: in-progress
created: 2026-10-18
priority: medium
scope: daemon, seat identity, native process proof
author: ctodie
references: [CER-2982, CER-2979, 0015-pane-read-failure-unavailable]
---

# 0016-transient-observation-unavailable

## Overview

Spec 0015 stopped a failed tmux pane read from down-ranking a seat. Three paths still turn a transient failed observation into a down-ranking `mismatch`. A down-ranked running seat projects `attention_required` in `rig ps`. Cortex-edge then deregisters it, and workflow role resolution skips it (0015, design item 4).

**Evidence.** In cw.4.2 release QA, case 2 injected an intermittent fault: each pane read failed independently with p = 1/2, over 12 samples of 3 managed Claude seats.
- 11 seat-samples went `attention_required`, against 12 on cw.4.1.
- In sample 7, all 3 seats went `attention_required` at once.
- Every one came through `mismatch` / `process_identity_ambiguous`, none through `pane_missing`.

Line numbers below are at cerebral `02d0a56f`.

**(a) Managed Claude seats, the main production shape** (a wrapper shell plus a resume token):
- The fleet sweep takes two native-process samples per selected seat (`seat-identity-reconciler.ts:222-237`). It keeps a proof only when both exist and their fingerprints agree (`:242-243`); otherwise the proof is `null`.
- `computeVerdict` then gives `verified` only when `native?.panePid === pid` (`:339`). Anything else is `mismatch` with reason `process_identity_ambiguous` (`:351-353`).
- **The native observers can't tell "couldn't see" from "saw something else".** Each returns `null` for all of these:
  - a failed or garbled `ps`: `listNativeProcesses` catches every error and returns `[]` (`native-process-lineage.ts:398-421`);
  - a failed pane pid read: `observeNativePaneProcess` returns `null` for a missing pid and on any throw (`:502-508`);
  - a pane pid absent from the `ps` rows (`nativeProcessCandidates`, `:443`);
  - more than one candidate, or a Claude argv naming another conversation (`selectNativeProcess`, `:469-485`).
- So one failed `ps` or pid read in either sample reads exactly like an identity contradiction.

**(b) Codex.**
- Upstream commit 6553aaef (2026-09-24, before the fork base) makes Codex fail-closed: an unavailable observation gives `mismatch` (`tmuxUnavailableVerdict`, `:264-274`; the binding branch, `:304`). A Codex seat is verified only with native proof (`:337-353`).
- The rule is pinned by the upstream test "cannot verify an unavailable pane". Every tmux blip down-ranks every running Codex seat. No Codex seat runs in this deployment today.

**(c) The rebind proof** (`rebindAndVerifyPaneIdentity`, `seat-attention-reconciler.ts:35`). It runs inside explicit operations: attention clear, restore (`restore-orchestrator.ts:1574`, `:1956`), restart-in-place (`seat-restart-in-place.ts:561`) and lifecycle.
- **The Claude and Codex rechecks** turn a failed listing or pid read into "no lineage": `listPanes(...).catch(() => [])` and `getPanePid(...).catch(() => null)` (`:110`, `:121-122`).
- **The strict branch** (restore and restart-in-place) runs `findExactNativeResumeProcess` over the array `listNativeProcesses()` (`:124-137`). A failed `ps` there gives `[]`, so no lineage.
- No lineage makes `runtimeAmbiguous` true (`:138`), and the verdict is `mismatch` / `process_identity_ambiguous` (`:143-157`).
- **The ordering problem.** The rebind writes the binding (`:169`) before the verdict (`:173`). The inventory ignores a verdict whose `registeredPane` differs from the binding (`node-inventory.ts:489`), so a write that is ordered wrongly silently stops a stored verdict applying.
- It never runs in the 5 s sweep, and the next sweep overwrites it (review r1 on #18). An operation can still record a down-rank from a blip.

**What a down-rank does.**
- `identityVerdictDownranksRunning` is true for `mismatch` and `pane_missing` only (`types.ts:636-640`). `node-inventory.ts:228` turns that into `attention_required`.
- `tmux_unavailable` and `verified` keep the stored status (`node-inventory.ts:268`, "fail-open on unknown", OPR.0.4.3.19).
- The sweep runs every 5 s (`DEFAULT_IDENTITY_POLL_INTERVAL_MS`, `seat-identity-reconciler.ts:15`) and skips a tick while reads are pending (`:139-147`).
- It keeps one verdict row per seat, overwritten on each pass (`seat-identity-store.ts:50-56`; table from migration 046).

**Cortex-edge's guard (CER-2979, done).** A discovery pass that skips every previously bound seat for startup status alone is treated as a failed discovery, so registrations survive. That guard covers only the all-seats case. A pass that down-ranks one or two seats still deregisters them, and workflow routing still skips them. This spec removes the cause; the edge guard stays as a backstop.

## Design

**Scope** (the lead's decisions, 2026-10-18):
- Items 1 and 2, with no hold and no migration. The bounded hold goes to upstream with the Codex proposal (item 4).
- **Revised after review r2's security read.** An earlier draft excused a foreground process descending from the seat's Claude. That rule is withdrawn: a shell escape from Claude's editor, or any job-control shell under Claude, is such a descendant, and that is exactly the squatting shell the reconciler exists to catch (r2's probe on a private socket).

**The rule.**
- An observation that isn't a reading (an unavailable one) gives the runtime's unavailable verdict, never `mismatch`.
- Positive evidence of something other than the seat's runtime gives `mismatch`: a contrary observation.
- A pane absent per 0015 gives `pane_missing`.

### Live checks (read-only, Claude Code 2.1.302 on the deployment's host)

What can take a pane's foreground, or add a second Claude to it:
- **The terminal external editor:** spawned with `stdio: "inherit"` and `IBr()` options, which carry only a `cgroup`, never `detached`. It stays in Claude's process group, so Claude stays in the foreground group.
- **A GUI editor:** spawned `detached`, with `stdio: "ignore"`, off the terminal.
- **Tool commands:** this seat's own tool shell runs in its own process group with no controlling terminal (`pgid` is its own pid, `tty ?`, `tpgid -1`).
- **Hooks:**
  - command hooks are spawned with `detached: true` and piped stdio;
  - git hooks and the runner hook likewise.
  - On POSIX `detached: true` makes a new session and process group, so a hook, and a `claude -p` it runs, is never in the pane's foreground group.
- **What takes Claude out of the foreground while Claude lives:** only a process that calls `tcsetpgrp`, that is, a job-control shell. A shell escape from the editor (`:sh`) does it (review r2's probe: the descendant `bash` held the foreground, and tmux reported `pane_current_command` = `bash`).

So none of Claude's own launches, tools or hooks takes Claude out of the pane's foreground group, or puts a second Claude in it. What does is a shell.

### 1. Native observations become three-way

The identity sweep and the rebind read the pane through typed variants of `observeNativePaneProcess`, `observeClaudePaneRuntime` and the verify helpers, which return one of these. The untyped helpers stay as they are for their other callers (claim, restore, delivery, restart-in-place and the runtime adapters), where no observation is already a refusal. "The seat's runtime" is the runtime candidate under the pane process that names the seat's conversation (the resume token, or the recorded rotation), or the sole candidate when there is no token.

**`proof`**: today's `NativeProcessObservation`. The seat's runtime is in the pane's foreground process group (its `pgid` equals the pane root's `tpgid`), and it is the only runtime candidate there.
- **Wrapper shape:** the wrapper shell leads the foreground group, with Claude inside it, so Claude is in the group: proof.
- **Editor shape:** the terminal editor runs in Claude's group: proof.

**`contrary`**: the pane pid and a consistent process list were both read, and they positively show something other than the seat's runtime:
- a Claude or Codex process whose argv names a different conversation (and isn't the recorded rotation, `rotationProcess`);
- a different agent runtime in the pane's foreground process group;
- the seat's runtime alive under the pane but **not** in the foreground group, **whatever** holds the foreground. That process is what the identity axis must flag, descendant or not.
- more than one runtime candidate in the foreground group. The live checks found no legitimate source (hooks and tools never put a Claude there), so no extra candidate is tolerated, `-p` or not. Today this is already `mismatch`.
- no runtime process under the pane process, when every process under it was fully read;
- a candidate whose executable path read was refused (`EACCES`).

**`unavailable`**: anything that isn't a reading:
- `ps` failed, exited non-zero, or parsed to zero rows. A successful `ps -A` always lists at least itself. Today's `catch { return [] }` becomes a typed failure.
- the pane pid read is unavailable (0015's `observePanePid`);
- the pane pid is missing from the `ps` rows: the pane process started or ended between the two reads;
- a candidate's executable path read failed because the process exited (`ENOENT` or `ESRCH`).
  - `readNativeExecutablePaths` (`native-process-executable.ts:30`) folds every `readlink` error into "no path" today.
  - It reports the error class instead: exited gives unavailable, refused gives contrary.
  - Caveat (review r2): a seat run under another unix user legitimately reads `EACCES`. When seats move to their own users, this rule needs that user's exe read, or it must be revisited.

**Precedence when several apply:**
- **Contrary over unavailable for positive evidence.** A candidate naming another conversation is contrary even if another reading failed.
- **Unavailable over "no runtime" when a read failed.** A sole candidate whose exe read failed (`ENOENT`/`ESRCH`) is unavailable, not "no seat runtime", because "no runtime" needs every process fully read.

**Combining the sweep's two samples:**

| first \ second | proof (same fingerprint) | proof (other fingerprint) | contrary | unavailable |
|---|---|---|---|---|
| proof | proof | unavailable | unavailable | unavailable |
| contrary | unavailable | unavailable | contrary | contrary |
| unavailable | unavailable | unavailable | contrary | unavailable |

- Proof needs both samples to agree.
- Positive evidence of another process wins over a failed read (the lead's ruling). A working seat never produces contrary, so this costs a legitimate seat nothing.

**What the sweep records:**
- `proof` gives `verified`.
- `contrary` gives `mismatch` / `process_identity_mismatch`.
- `unavailable` gives the runtime's unavailable verdict: `tmux_unavailable` for `claude-code` and `terminal`. That is never down-ranked (`node-inventory.ts:268`); it replaces today's `mismatch` / `process_identity_ambiguous` at `seat-identity-reconciler.ts:339-353`.
- A seat the sweep did not sample (its selection read failed, or its label changed between the selection read and the final one) has no native reading, so it is unavailable too. The next sweep samples it, so a takeover is still flagged within one sweep of the first successful observation (item 3).

`listNativeProcesses` keeps its array result for callers outside identity proof (menu input). The sweep and the rebind read through a typed variant.

### 2. The rebind reports a failed lookup, not a mismatch

In `rebindAndVerifyPaneIdentity`, each of these gives "tmux pane identity lookup failed", records no verdict, and **leaves the binding unchanged**:
- a failed `listPanes`;
- a failed pid read;
- an unavailable native observation, in the Claude and Codex rechecks and in the strict branch (which moves to the typed `ps` variant).

The return comes before `updateBinding` (`:169`), as 0015's pid-read return already does.
- A contrary observation still records `mismatch` (binding first, then the verdict, as today).
- The callers already refuse on any rebind failure: `clearAttention` returns `not_demonstrably_responsive`. So "lookup failed" lets no operation proceed that refuses today.

### 3. The identity security goal

The identity axis exists to catch a pane that something other than the seat's runtime occupies: a squatting shell, a different agent, or a different conversation.
- **While observations work**, a takeover that presents a shell label at its prompt, or another agent's label, gives a contrary observation. It is recorded at the next sweep: about 5 s plus sampling.
  - That includes a shell started under Claude (an editor shell escape). It reads `attention_required` until it exits, which is intended and is today's behaviour.
- **While observations of that seat fail**, the seat reads `tmux_unavailable` from the first failed sweep, never a stale `verified`. That verdict is unverified but not down-ranked: 0015's fail-open rule for Claude and terminal seats, unchanged.
- **The stated bound:** such a takeover is flagged within one sweep of the first successful observation after it.
- **Known limitations, which predate this spec** (follow-ups, not changed here):
  - **The lenient label path.** The native observation runs only when the pane's foreground label is a shell, or for Codex (`seat-identity-reconciler.ts:216`, `:337-338`).
    - Any other label, such as `python3`, `vim`, `sleep` or a shell's running job, goes to `classifyPaneRuntimeMatch`. That returns `match` for anything that isn't a shell or another agent (`:47-63`), and the verdict is `verified` with no process proof (`:358`).
    - The bound above therefore covers the shell-label and agent-label paths only.
  - **A hung read.** The `ps` exec has no timeout, and the sweep skips ticks while reads are pending and never releases on a deadline (`:139-147`). A read that never returns freezes every seat's last verdict, `verified` included.
    - "Never a stale `verified`" holds for reads that fail and return.
  - **A Claude started by an MCP server** (review r2's re-read).
    - An MCP stdio server that is not detached runs in Claude's process group, so a `claude -p` it starts (the clauth delegate, for example) is a second runtime candidate in the pane's foreground group while it runs.
    - The seat reads `mismatch` and `attention_required` for the length of that run, and clears itself at the next sweep after it.
    - That is today's behaviour too; this spec doesn't change it.
  - **Not an integrity monitor.** An attacker who can break the daemon's tmux or `ps` access for every read already controls the host, and a same-user process can already copy a seat's argv. The identity axis is not a host-integrity monitor.

### 4. Codex: keep upstream's rule in the fork; take the hold upstream

- **Recommendation:** don't change 6553aaef's rule in the fork. A Codex seat keeps `mismatch` on an unavailable observation.
- Item 1 still separates the reasons. An unavailable observation gives `mismatch` / `tmux_unavailable`; a contrary one gives `mismatch` / `process_identity_mismatch`.
  - **The verdict is exactly upstream's.** Its pinned test, "keeps fresh Codex distinct from resume, and cannot verify an unavailable pane" (`seat-identity-reconciler.test.ts:280`), asserts only the verdict.
  - **The reason text changes** for a failed native proof: `process_identity_ambiguous` today. Nothing branches on it; restore-check prints it (`restore-check-service.ts:851`).
- **Why:**
  - no Codex seat runs in this deployment;
  - the rule is pinned upstream, so changing it in the fork diverges on a security choice;
  - CER-2982 says to raise it upstream first.
- **The upstream proposal** (not a fork change): keep a seat's last decisive verdict through a bounded run of unavailable observations, then fall back to the runtime's unavailable rule.
  - The bound is at least 30 s AND at least 3 consecutive sweeps. Both are needed because a stalled sweep can outlast 30 s, and 3 fast sweeps take only 15 s.
  - That would let a Codex seat ride out a blip while staying fail-closed for a real outage.
  - It would also keep `verified` for the readers that require it. One is the model-divergence monitor's Claude read (`model-divergence/current-generation-record.ts:131-133`, via `startup.ts:2368`), which today skips a pass that hits a blip. It retries on the next pass, so the cost is a delay, not a wrong answer.

### 5. Not in scope

- The bounded hold and any migration (item 4).
- The known limitations in item 3: the lenient label path and the `ps` timeout.
- The 0015 fail-open rule for Claude and terminal seats.
- Cortex-edge's guard (CER-2979).
- Workflow role resolution's use of `lifecycleState`.

## Requirements

- REQ-0016-01: If a native process observation cannot read the process list or the pane pid, or a candidate exited before its executable path was read, then the observer shall report the observation unavailable.
- REQ-0016-02: When the sweep combines its two samples, it shall report proof only for two proofs with the same fingerprint, contrary when either sample is contrary and neither is a proof, and unavailable otherwise.
- REQ-0016-03: When the process list shows a different runtime or a different conversation in the pane's foreground group, the observer shall report a contrary observation.
- REQ-0016-04: While the seat's runtime is alive under the pane but not in the pane's foreground process group, the observer shall report a contrary observation.
- REQ-0016-05: When the pane's foreground group holds more than one runtime candidate, the observer shall report a contrary observation.
- REQ-0016-06: When a Claude or terminal seat's native observation is unavailable, the identity reconciler shall record `tmux_unavailable`.
- REQ-0016-07: While a seat runs Codex, the identity reconciler shall record `mismatch` for an unavailable observation.
- REQ-0016-08: If the rebind cannot list the panes, read the pid or observe the runtime, then the rebind shall report the identity lookup failed, record no verdict and leave the binding unchanged.
- REQ-0016-09: When every process under the pane was fully read and none is a runtime candidate, the observer shall report a contrary observation.
- REQ-0016-10: If a candidate's executable path read is refused, then the observer shall report a contrary observation.

## Plan

1. This spec. Scope (i) was chosen in review; it was revised after the security read, and comes back for a re-read before any code.
2. One fork PR, naming CER-2982: the three-way observation (item 1) and the rebind change (item 2), with their tests. No migration.
3. The upstream proposal for the bounded hold and Codex (item 4), not a fork change.
4. Follow-ups for item 3's known limitations: native proof for non-shell labels, and a timeout on the `ps` exec.

## Test

**Unit, with scripted panes and process lists. The three-way observer:**
- `ps` throws, exits non-zero or returns zero rows: unavailable.
- The pane pid is unavailable, or missing from the rows: unavailable.
- A Claude candidate whose exe read hit `ENOENT`/`ESRCH`: unavailable; with `EACCES`: contrary.
- A Claude argv naming another token (not the rotation): contrary.
- No runtime under the pane, with every process read: contrary.
- A Codex process in a Claude seat's foreground group: contrary.
- **The foreground rule, each red first where today differs:**
  - the wrapper shape (the shell leads the foreground group, Claude inside it): proof;
  - the terminal editor in Claude's group: proof;
  - Claude alive, the foreground held by a shell descending from Claude (an editor shell escape): contrary;
  - Claude alive, the foreground held by a non-descendant: contrary.
- **Extra candidates:** a second Claude in the foreground group, with `-p` or without, descendant or not: contrary.
- **Precedence:** a candidate naming another conversation alongside a failed read: contrary. A sole candidate whose exe read failed with `ENOENT`: unavailable.
- **The two-sample table:** each cell of the table in item 1.

**The sweep:**
- A verified managed Claude seat with one failed native sample gets `tmux_unavailable`. Today it gets `mismatch` / `process_identity_ambiguous`: red first.
- A contrary observation gives `mismatch` / `process_identity_mismatch`.

**Codex:** an unavailable observation is `mismatch` / `tmux_unavailable`, the verdict exactly as upstream (upstream's pinned test still passes); a contrary one is `mismatch` / `process_identity_mismatch`.

**The rebind:**
- A failed `listPanes`, pid read or `ps` gives "tmux pane identity lookup failed", records no verdict, and leaves the binding unchanged.
- This holds in the Claude and Codex rechecks and in the strict branch (restore and restart-in-place); the strict branch's failed `ps` is red first.
- A contrary observation records `mismatch`.

**Break-once:** each rule, broken on purpose, turns its test red.

**Integration (the QA case 2 harness, 3 managed Claude seats, 12 or more samples):**
- **Intermittent fault (p = 1/2 per pane read, plus injected `ps` failures):** zero seat-samples `attention_required`, and zero all-seat down-ranks. The controls are the cw.4.2 release (11 seat-samples, 3/3 in one sample) and cw.4.1 (12).
- **A real mismatch under the same fault:**
  - replace one seat's Claude with a shell, then with a Claude naming another conversation, then take the foreground with a shell started under Claude;
  - that seat is `mismatch` and `attention_required` within one sweep of the first successful observation, and the other two seats stay `running`.
- **A total tmux outage:** Claude seats are `tmux_unavailable`, never `attention_required`, as 0015 already does.
