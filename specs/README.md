# OpenRig Fork LeanSpec Registry

Lightweight specifications following the [LeanSpec methodology](https://github.com/codervisor/lean-spec) with EARS requirement syntax, as adopted across the Cerebral and Unsigned estates. These govern the cerebral-work fork only; upstream documentation lives under `docs/`.

**Spec first:** a feat or fix to the fork creates or updates a spec here before code, and its pull request names that spec. See [AGENTS.md](../AGENTS.md). `lsc check specs/` (unsigned-gg/lsc) runs locally and on every pull request (`.github/workflows/lsc.yml`).

## Index of LeanSpecs

| Spec | Title | Status | Scope | Cross-References |
|---|---|---|---|---|
| [0001](0001-fork-distribution-model.md) | Fork Distribution Model (vendor-branch) | accepted | git, release, xtask | [FORK.md](../FORK.md) |
| [0002](0002-agy-runtime.md) | agy (Google Antigravity CLI) runtime (retro) | complete | daemon, adapters, ui, tui | PR #1 |
| [0003](0003-fresh-shell-launch-readiness.md) | Fresh-shell launch readiness (retro; pane modes added) | complete | daemon, launcher, tmux | PR #3, PR #8, CER-2889 |
| [0004](0004-stuck-finding-source-evidence.md) | Stuck findings resolve only on source evidence (retro); stall age from the stall anchor | complete | daemon, queue | PR #4, CER-2984 |
| [0005](0005-cross-runtime-seat-migration.md) | Cross-runtime seat migration | complete | daemon, cli, handover, seat-lifecycle | [0001](0001-fork-distribution-model.md), SEC-178 |
| [0006](0006-seat-launch-env-filter.md) | Seat launches drop every HERDR_* name | complete | daemon, tmux, seat launch | PR #7, SEC-178 |
| [0008](0008-rig-edge-add.md) | `rig edge add`: an edge between existing seats | complete | daemon, cli, topology | feat/factory-expansion-fixes |
| [0009](0009-workflow-rig-name-resolution.md) | Workflow rig-name resolution: unarchived rigs only | complete | daemon, workflow | feat/factory-expansion-fixes |
| [0010](0010-workflow-human-gate-targets.md) | Workflow gate targets: forms and hints | complete | daemon, workflow, docs | feat/factory-expansion-fixes |
| [0012](0012-startup-submission-verification.md) | Startup submission verification: boundary re-look, transcript confirmation, required sends | in-progress | daemon, startup, claude adapter | revenant gap 1 |
| [0013](0013-seat-env-allowlist.md) | Seat env allow-list mode (off by default) | complete | daemon, tmux, seat launch, config | SEC-178, extends 0006 |
| [0014](0014-launch-graph-cycles.md) | Launch-dependency cycles: restore holds, growth refuses | in-progress | daemon, restore, topology growth | CER-2976 |
| [0015](0015-pane-read-failure-unavailable.md) | A failed tmux pane read is unavailable, never pane_missing | in-progress | daemon, tmux, seat identity | cortex mesh flap, cw.4.2 |

## Requirements Syntax (EARS)

Each requirement is one top-level list item (`- REQ-NNNN-nn: <sentence>.`) with exactly one `shall`:

```text
- REQ-0001-01: The <system> shall <response>.
- REQ-0001-02: When <trigger>, the <system> shall <response>.
- REQ-0001-03: While <state>, the <system> shall <response>.
- REQ-0001-04: If <condition>, then the <system> shall <response>.
- REQ-0001-05: Where <feature>, the <system> shall <response>.
```

`cargo xtask spec-check` enforces sections, requirement id format and uniqueness, the single-`shall` rule, and the README index.

## History triage (CER-2914)

The 2026-10-18 LeanSpec audit found 3 merged fork pull requests with no spec. All three are live behaviour, so each has a retro spec.

| PR | Outcome | Reason |
|---|---|---|
| #1 feat(daemon): agy runtime | Retro spec | Live runtime adapter since cw.2, now 0002. |
| #3 fix(launcher): fresh shell readiness (CER-2889) | Retro spec | Live launch path since cw.3, now 0003. |
| #4 fix(queue): source evidence for stuck findings | Retro spec | Live queue sweep from cw.4, now 0004. |

Counts: 0 linked, 3 retro specs, 0 exempt.
