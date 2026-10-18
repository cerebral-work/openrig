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

cw.4, cw.4.1 and cw.4.2 are based on untagged upstream `main` at `f41740137f3d3ab807f5f24e559b9845632ed908`, not on a release tag.

## Estate changes

- **The default bind is loopback only until the fork has auth** (CER-2924). With no `OPENRIG_BIND_HOST`, the daemon binds `127.0.0.1`; upstream also binds the tailscale IP, and upstream's default is unchanged. Tailnet exposure is opt-in: `OPENRIG_BIND_HOST=<address>` binds exactly that address. Following upstream's explicit behaviour, loopback is then not also bound, and a bind that is neither loopback nor tailnet needs `OPENRIG_AUTH_BEARER_TOKEN`.
- **LeanSpec and lsc** (CER-2914): fork specs live in `specs/` (index in `specs/README.md`), agents follow the spec-first rule in [AGENTS.md](AGENTS.md), and `.github/workflows/lsc.yml` runs `lsc check specs/` on every pull request, in warn mode for now.
- **GitHub-hosted runners for CI** (CER-2908 exception): this fork is public, and the estate runner group `ent-default` is not workflow-restricted, so fork-PR code must not run there (OPS-1695). Pull-request runs of `estate-xwork.yml` and all runs of `lsc.yml` use `ubuntu-latest`. A push to `cerebral` runs `estate-xwork.yml` on the workflow-restricted `ent-parity` group (scale set ci-parity). Both workflows are read-only and use no secrets.

## Releases

Tag the `cerebral` commit `cw-v<version>` (for example `cw-v0.6.10-cw.4.2`). The `cw-v*` prefix is disjoint from upstream `v*` tags, so tag syncs never cross-fire release workflows.

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
| `cargo xwork --skip <gate>` | Exclude a gate (never cached as passed). CI excludes `npm-test-workspaces`: upstream's daemon/cli suites assume macOS and run on `macos-latest` in upstream's `tests.yml` |
| `cargo xtask hygiene --break-check` | Each gate also proves it fails on a deliberately broken input |
| `cargo xtask stack` | Read-only branch / GitButler status |
| `cargo xwork --pre-push` | Hygiene, plus xtask fmt/clippy/test if Rust inputs changed vs the `origin/cerebral` merge-base |

The pipeline also runs the repo's own gates unchanged: `npm run lint`, `test:repo`, `test:workspaces`, `build:package`. `make help` lists the Makefile targets. `lefthook.yml` enforces Conventional Commits, gitleaks and the pre-push gate. CI: `.github/workflows/estate-xwork.yml`.
