# cerebral-work/openrig fork

Vendor-branch fork of [mvschwarz/openrig](https://github.com/mvschwarz/openrig). Normative spec: [specs/0001-fork-distribution-model.md](specs/0001-fork-distribution-model.md).

## Branches

| Branch | Role |
|---|---|
| `main` | Mirror of `upstream/main`. Fast-forward only; never carries our commits. |
| `cerebral` | Distribution branch and fork default: an upstream release tag plus estate commits (version pin `X.Y.Z-cw.N`, tooling, patches). |
| `feat/` `fix/` `chore/` `cw/` ... | Feature branches cut from `cerebral`, merged by PR into `cerebral`. |
| `up/<feature>` | Clean copy of a generally useful change, cut from `upstream/main`, for an upstream PR. |

## Upstream sync

```bash
git remote add upstream git@github.com:mvschwarz/openrig.git   # once
git fetch upstream --tags
git switch main && git merge --ff-only upstream/main && git push origin main
# new upstream release vX.Y.Z: rebase the estate commits onto the tag
git rebase --onto vX.Y.Z <old-upstream-tag> cerebral
```

Resolve conflicts toward upstream unless the estate change is intentionally kept. Re-run `cargo xwork` before pushing `cerebral`.

## Releases

Tag the `cerebral` commit `cw-v<version>` (for example `cw-v0.6.10-cw.1`). The `cw-v*` prefix is disjoint from upstream `v*` tags, so tag syncs never cross-fire release workflows.

## GitButler

The main checkout is managed by GitButler (`but`) with target `origin/cerebral`:

```bash
but setup && but config target origin/cerebral
but branch new feat/<slug>
but commit feat/<slug> -m "feat(scope): description"
but push feat/<slug> && but pr new feat/<slug>
```

Do not run `git` write commands in the managed checkout. `gitbutler/workspace` is a valid branch for every gate.

## Gates

Rust `xtask` (host throttle `-j 2`, set in `.cargo/config.toml`), driven by [projectfile.yaml](projectfile.yaml):

| Command | What it does |
|---|---|
| `cargo xwork` | All gates in DAG order with a BLAKE3 checkpoint cache (`target/xtask-cas/`); an unchanged tree skips passed gates |
| `cargo xtask hygiene` | `projectfile-check`, `stages-check`, `spec-check`, `branch-hygiene` (no compile of project code) |
| `cargo xtask check` | Same pipeline as `xwork` |
| `cargo xtask hygiene --break-check` | Each gate also proves it fails on a deliberately broken input |
| `cargo xtask stack` | Read-only branch / GitButler status |
| `cargo xwork --pre-push` | Hygiene, plus xtask fmt/clippy/test if Rust inputs changed vs the `origin/cerebral` merge-base |

The pipeline also runs the repo's own gates unchanged: `npm run lint`, `test:repo`, `test:workspaces`, `build:package`. `make help` lists the Makefile targets. `lefthook.yml` enforces Conventional Commits, gitleaks and the pre-push gate. CI: `.github/workflows/estate-xwork.yml`.
