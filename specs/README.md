# OpenRig Fork LeanSpec Registry

Lightweight specifications following the [LeanSpec methodology](https://github.com/codervisor/lean-spec) with EARS requirement syntax, as adopted across the Cerebral and Unsigned estates. These govern the cerebral-work fork only; upstream documentation lives under `docs/`.

**Spec first:** a feat or fix to the fork creates or updates a spec here before code, and its pull request names that spec. See [AGENTS.md](../AGENTS.md). `lsc check specs/` (unsigned-gg/lsc) runs locally and on every pull request (`.github/workflows/lsc.yml`).

## Index of LeanSpecs

| Spec | Title | Status | Scope | Cross-References |
|---|---|---|---|---|
| [0001](0001-fork-distribution-model.md) | Fork Distribution Model (vendor-branch) | accepted | git, release, xtask | [FORK.md](../FORK.md) |
| [0002](0002-agy-runtime.md) | agy (Google Antigravity CLI) runtime (retro) | complete | daemon, adapters, ui, tui | PR #1 |
| [0003](0003-fresh-shell-launch-readiness.md) | Fresh-shell launch readiness (retro) | complete | daemon, launcher, tmux | PR #3, CER-2889 |
| [0004](0004-stuck-finding-source-evidence.md) | Stuck findings resolve only on source evidence (retro) | complete | daemon, queue | PR #4 |

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
