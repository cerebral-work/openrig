---
status: accepted
created: 2026-10-17
priority: high
scope: git, release, xtask
author: ctodie
references: []
---

# 0001-fork-distribution-model

## Overview

`cerebral-work/openrig` is a fork of `mvschwarz/openrig` run as a vendor-branch fork, the same model the estate uses for herdr (`~/.agents/sops/herdr-fork-and-distribution.md`). Upstream history stays pristine on `main`; the estate's build lives on `cerebral`. This spec is the first content validated by `cargo xtask spec-check` and is the normative source for [FORK.md](../FORK.md).

## Design

1. **`main`** mirrors `upstream/main` by fast-forward only and carries no estate commits.
2. **`cerebral`** is the distribution branch and the fork's default branch: an upstream release tag plus estate commits (version pin, tooling, patches).
3. **Feature branches** are cut from `cerebral` with an estate prefix (`feat/`, `fix/`, `chore/`, `cw/`, `up/`) and merged back by pull request.
4. **Releases** are tagged `cw-v<version>` on `cerebral`, disjoint from upstream's `v*` tags.
5. **Upstream sync** rebases `cerebral` onto each new upstream release tag.
6. **GitButler** manages the main checkout with `origin/cerebral` as the target; the `gitbutler/workspace` ref is a valid branch.
7. **Workflow triggers (CER-2908).** No workflow under `.github/workflows/` may declare a `pull_request_target` or `workflow_run` trigger. Such a run executes as `refs/heads/cerebral`, so it would match the `ent-parity` runner group's workflow restriction and could put fork-influenced code on the self-hosted pool.
   - The `workflow-trigger-check` gate parses each workflow's `on` in every form: scalar, list or map. It reads the key `on` both as a string and as YAML 1.1's boolean `true`.
   - It runs in `cargo xwork`. A pull request run is an early warning; the trusted push run on `cerebral` is the alarm.
   - `.github/CODEOWNERS` makes `@todie` and `@LordVoid` the owners of `.github/workflows/**`.

## Requirements

- REQ-0001-01: The `main` branch shall be updated only by fast-forward from `upstream/main`.
- REQ-0001-02: The `main` branch shall contain no commits authored for the cerebral-work fork.
- REQ-0001-03: The `cerebral` branch shall be the default branch of the fork and the source of every distributed build.
- REQ-0001-04: When a change is started, the author shall cut its feature branch from `cerebral`.
- REQ-0001-05: When a feature branch is ready, the author shall open a pull request into `cerebral`.
- REQ-0001-06: When a release is cut, the maintainer shall tag the `cerebral` commit as `cw-v<version>`.
- REQ-0001-07: When upstream publishes a new release tag, the maintainer shall rebase `cerebral` onto that tag.
- REQ-0001-08: If a rebase onto an upstream tag conflicts, then the maintainer shall resolve it in favour of upstream unless the estate change is intentionally retained.
- REQ-0001-09: Where a change is generally useful, the maintainer shall offer a clean copy to upstream from an `up/<feature>` branch cut from `upstream/main`.
- REQ-0001-10: The branch-hygiene gate shall reject any current branch that is not `main`, `cerebral`, `gitbutler/workspace`, or a `<type>/<slug>` branch.
- REQ-0001-11: If a file under `.github/workflows/` declares a `pull_request_target` or `workflow_run` trigger in any `on` form, then the workflow-trigger-check gate shall fail, naming the file and the trigger.

## Plan

1. Land the estate `xtask` / `xwork` tooling on `cerebral` ([projectfile.yaml](../projectfile.yaml), [Makefile](../Makefile)).
2. Document the procedures in [FORK.md](../FORK.md).
3. Migrate the main checkout to GitButler with target `origin/cerebral`.

## Test

```bash
cargo xtask spec-check
cargo xtask branch-hygiene
cargo xtask xwork --only workflow-trigger-check --break-check
cargo xwork
```

## Notes

Reference: the herdr vendor-branch SOP, with `cerebral` in the role herdr gives to `unsigned`.
