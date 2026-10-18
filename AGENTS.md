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
