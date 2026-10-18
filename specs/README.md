# OpenRig Fork LeanSpec Registry

Lightweight specifications following the [LeanSpec methodology](https://github.com/codervisor/lean-spec) with EARS requirement syntax, as adopted across the Cerebral and Unsigned estates. These govern the cerebral-work fork only; upstream documentation lives under `docs/`.

## Index of LeanSpecs

| Spec | Title | Status | Scope | Cross-References |
|---|---|---|---|---|
| [0001](0001-fork-distribution-model.md) | Fork Distribution Model (vendor-branch) | accepted | git, release, xtask | [FORK.md](../FORK.md) |
| [0005](0005-cross-runtime-seat-migration.md) | Cross-runtime seat migration | planned | daemon, cli, handover, seat-lifecycle | [0001](0001-fork-distribution-model.md) |

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
