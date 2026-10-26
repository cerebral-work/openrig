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
5. **Upstream sync** brings `cerebral` up to each new upstream release tag. A rebase is the default. When the estate patches are too many to rebase without rewriting the history of `cerebral`, the maintainer merges the tag instead and records that in the pull request.
6. **GitButler** manages the main checkout with `origin/cerebral` as the target; the `gitbutler/workspace` ref is a valid branch.
7. **Workflow triggers (CER-2908).** No workflow under `.github/workflows/` may declare a `pull_request_target` or `workflow_run` trigger. Such a run executes as `refs/heads/cerebral`, so it would match the `ent-parity` runner group's workflow restriction and could put fork-influenced code on the self-hosted pool.
   - The `workflow-trigger-check` gate parses each workflow's `on` in every form: scalar, list or map. It reads the key `on` both as a string and as YAML 1.1's boolean `true`.
   - The gate fails closed on anything it cannot read: a custom YAML tag anywhere in the file, a merge key `<<` (GitHub rejects them), no readable `on` key, an `on` that is empty, a number or a bool, and a list entry or map key under `on` that is not a trigger name. Each finding names the file, the construct and the fix. A test pins that the repository's own workflows pass.
   - It runs in `cargo xwork`. A pull request run is an early warning; the trusted push run on `cerebral` is the alarm.
   - `.github/CODEOWNERS` makes `@todie` and `@LordVoid` the owners of `.github/workflows/**`.
8. **The full suite on every pull request (CER-2937).** `npm run test:workspaces` runs on every pull request to `cerebral`, so a change's author doesn't run it locally.
   - **The workflow.** `.github/workflows/full-suite.yml` triggers only on `pull_request` to `cerebral` and on `workflow_dispatch`, and runs only on GitHub-hosted `ubuntu-latest`.
     - **Why its own file:** `estate-xwork.yml` sends its push runs to the `ent-parity` group, and that group's workflow restriction names `estate-xwork.yml`. A pull-request-only file on `ubuntu-latest` can never reach the self-hosted pool.
     - It has no `push` trigger, so a merge doesn't run the suite again.
   - **The steps:**
     - checkout; the repo's Node (22); tmux, installed with `apt-get` when missing; `npm ci`; then `npm run build`, because the suites import built packages, as `tests.yml` does before its suites.
     - **The suites:** each workspace that `test:workspaces` names (`cargo xtask suite-baseline workspaces` reads the list from `package.json`) runs through its own `test` script. Each run writes vitest's JSON report, plus an unhandled-error count from `.github/full-suite/unhandled-reporter.mjs`: the JSON report doesn't record unhandled errors.
     - The suites run under `env -i`, with a temporary `HOME`, `PATH`, `TERM`, `CI`, `TMPDIR` and the reporter's output path, so test code sees no runner credentials.
     - Each workspace's exit code is recorded, and a failing workspace doesn't stop the next one. The reports are uploaded whatever the outcome.
     - The job's timeout is 60 minutes.
   - **The check:** `cargo xtask suite-baseline check` compares the reports with the known-failure baseline, `.github/full-suite-baseline.json`.
     - **An entry's key** is its file, relative to the repository root, and its test: the describe titles and the test title joined with ` > `.
       - A file that fails without a failed test (an import error, a failed hook) has the test `(file)`.
       - A workspace's unhandled errors have the workspace directory as the file and the test `(unhandled errors)`.
     - **An entry's fields:**
       - its kind: `fails` or `flaky`;
       - a reason, naming the Linux cause (no tty, timing, a macOS-only behaviour), or a filed ticket for a real defect;
       - its evidence: https run URLs. A `flaky` entry needs two: a run where it failed and one where it passed.
     - **The verdicts:**
       - a failure with no entry fails the job;
       - a `fails` entry that passes fails the job, so the baseline can't rot;
       - a `flaky` entry may pass or fail, and a pass is reported as a notice;
       - an entry that the reports don't contain fails the job, whatever its kind;
       - a missing or unreadable report fails the job, and so does a non-zero exit that no recorded failure explains;
       - an invalid entry fails the job.
   - **Seats' local gates:** once this job is green on a pull request's head, its author doesn't run the full suite locally ([AGENTS.md](../AGENTS.md)).

## Requirements

- REQ-0001-01: The `main` branch shall be updated only by fast-forward from `upstream/main`.
- REQ-0001-02: The `main` branch shall contain no commits authored for the cerebral-work fork.
- REQ-0001-03: The `cerebral` branch shall be the default branch of the fork and the source of every distributed build.
- REQ-0001-04: When a change is started, the author shall cut its feature branch from `cerebral`.
- REQ-0001-05: When a feature branch is ready, the author shall open a pull request into `cerebral`.
- REQ-0001-06: When a release is cut, the maintainer shall tag the `cerebral` commit as `cw-v<version>`.
- REQ-0001-07: When upstream publishes a new release tag, the maintainer shall bring `cerebral` up to that tag by rebase, or by merging the tag when a rebase would rewrite the history of `cerebral`. The pull request states which method was used and why.
- REQ-0001-08: If a rebase or merge of an upstream tag conflicts, then the maintainer shall resolve it in favour of upstream unless the estate change is intentionally retained.
- REQ-0001-09: Where a change is generally useful, the maintainer shall offer a clean copy to upstream from an `up/<feature>` branch cut from `upstream/main`.
- REQ-0001-10: The branch-hygiene gate shall reject any current branch that is not `main`, `cerebral`, `gitbutler/workspace`, or a `<type>/<slug>` branch.
- REQ-0001-11: If a file under `.github/workflows/` declares a `pull_request_target` or `workflow_run` trigger in any `on` form, then the workflow-trigger-check gate shall fail, naming the file and the trigger.
- REQ-0001-12: If a file under `.github/workflows/` uses a custom YAML tag or a merge key, has no readable `on` key, or has an `on` value or entry that is not a trigger name, then the workflow-trigger-check gate shall fail, naming the file, the construct and the fix.
- REQ-0001-13: When a pull request targets `cerebral`, the full-suite workflow shall run every workspace suite that `test:workspaces` names on a GitHub-hosted `ubuntu-latest` runner.
- REQ-0001-14: The full-suite workflow shall declare only the `pull_request` and `workflow_dispatch` triggers and only the `ubuntu-latest` runner.
- REQ-0001-15: If a test, a test file or a workspace's unhandled errors fail with no baseline entry, then the suite-baseline check shall fail, naming each.
- REQ-0001-16: If a `fails` baseline entry passes, or any baseline entry is absent from the reports, then the suite-baseline check shall fail, naming the entry.
- REQ-0001-17: When a `flaky` baseline entry passes, the suite-baseline check shall report it as a notice without failing.
- REQ-0001-18: If a workspace's report is missing or unreadable, or its suite exited non-zero with no recorded failure, then the suite-baseline check shall fail.
- REQ-0001-19: If a baseline entry has no reason, lacks its https run URLs, names a missing file or repeats another entry's key, then the suite-baseline check shall fail.

## Plan

1. Land the estate `xtask` / `xwork` tooling on `cerebral` ([projectfile.yaml](../projectfile.yaml), [Makefile](../Makefile)).
2. Document the procedures in [FORK.md](../FORK.md).
3. Migrate the main checkout to GitButler with target `origin/cerebral`.
4. Run the full suite on every pull request (item 8), with a reviewed Linux baseline gathered from repeated runs of one head.

## Test

```bash
cargo xtask spec-check
cargo xtask branch-hygiene
cargo xtask xwork --only workflow-trigger-check --break-check
cargo test -p xtask suite_baseline
cargo xwork
```

## Notes

Reference: the herdr vendor-branch SOP, with `cerebral` in the role herdr gives to `unsigned`.
