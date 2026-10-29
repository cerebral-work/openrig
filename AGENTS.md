# AGENTS.md — cerebral-work/openrig fork

Estate rules for agents working on this fork. They add to upstream's contributor guidance (`.claude/skills/developing-openrig/SKILL.md`, `CONTRIBUTING.md`) and to [FORK.md](FORK.md); they do not replace it.

A Codex or agy seat rooted in this checkout gets `<!-- BEGIN OpenRig MANAGED BLOCK: ... -->` sections merged into this file at launch; never commit them.

## Spec first (LeanSpec)

- A feat or fix creates or updates a spec in `specs/` before any code changes.
- **Wave-0 Spec Batch → Wave-1 Implementation Fan-Out:** When running multi-ticket waves or parallel subagents, land all `NNNN..NNNN+k` specs and their `specs/README.md` rows upfront in a single Wave-0 pull request (`docs(specs): ...`) before dispatching builders. Parallel Wave-1 implementation pull requests must cite their pre-allocated spec (`NNNN-slug` or `REQ-NNNN-nn`) in the PR title or body without modifying `specs/`.
- The pull request names that spec in its title or body, as a `specs/` path or `NNNN-slug`, or it touches a file under `specs/`.
- `specs/README.md` gives the spec format and the index. Add every new spec to the index (`.gitattributes` configures `specs/README.md merge=union` to auto-merge concurrent table appends).
- Before pushing, run `lsc check specs/` (unsigned-gg/lsc) and `cargo xtask spec-check`, and get 0 errors from both.
- CI runs the reusable lsc job on every pull request (`.github/workflows/lsc.yml`).
  - The spec-link check applies to pull requests whose title starts `feat` or `fix`.
  - Both checks only warn for now. They become blocking once the backfill is done.

## The full suite runs in CI (CER-2937)

- `.github/workflows/full-suite.yml` runs every suite `npm run test:workspaces` names, on each pull request to `cerebral`, on GitHub-hosted `ubuntu-latest`. It compares the failures with the Linux baseline, `.github/full-suite-baseline.json` (spec 0001 item 8).
- **Once that job is green on your pull request's head, don't run the full suite locally:** neither `npm run test:workspaces` nor a `cargo xwork` that includes `npm-test-workspaces`. Use `cargo xwork --skip npm-test-workspaces`.
- **Still run locally:** the suites for the files you change, and red-first and break-once for each rule you add.
- **A test that fails on Linux for an environmental reason** goes in the baseline in the same pull request, with its reason and the run URL. A `flaky` entry needs two runs: one where it failed and one where it passed.
- **A real defect is filed as a ticket**, and the entry's reason names it. Never baseline one silently.
- **When a baselined test starts passing,** the job fails until its entry is removed.

## Canonical Estate References (`handbook` & `agentic`)

All agents working in this repository must consult the two canonical estate reference repositories:
- **`cerebral-work/handbook`** (`~/projects/mesh/comms/handbook/`): Organizational handbook (`START-HERE.md`, `where-things-live.md`, `how-to-get-merged.md`, `people.md`, `communicate-in-controlled-language.md`, and `sops/`).
- **`unsigned-gg/agentic`** (`~/projects/agents/harness/agentic/`): Shared agent harness configurations, reusable skills (`packages/skills/`), lane personas (`packages/claude-agents/bin/lane-persona`), and estate context (`packages/context/estate.md`, `~/.agents/estate.md`).
