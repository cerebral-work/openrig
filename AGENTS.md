# AGENTS.md — cerebral-work/openrig fork

Estate rules for agents working on this fork. They add to upstream's contributor guidance (`.claude/skills/developing-openrig/SKILL.md`, `CONTRIBUTING.md`) and to [FORK.md](FORK.md); they do not replace it.

A Codex or agy seat rooted in this checkout gets `<!-- BEGIN OpenRig MANAGED BLOCK: ... -->` sections merged into this file at launch; never commit them.

## Spec first (LeanSpec)

- A feat or fix creates or updates a spec in `specs/` before any code changes.
- The pull request names that spec in its title or body, as a `specs/` path or `NNNN-slug`, or it touches a file under `specs/`.
- `specs/README.md` gives the spec format and the index. Add every new spec to the index.
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
