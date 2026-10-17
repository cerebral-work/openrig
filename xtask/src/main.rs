//! `xtask` / `cargo xwork` — checkpointed estate verification pipeline for the
//! OpenRig fork (cerebral-work/openrig).
//!
//! Gates (the lowered `projectfile.yaml` CI DAG, see `stages.rs`):
//!   - `projectfile-check`     Validate `projectfile.yaml` identity, repositories and version
//!   - `stages-check`          Verify `xtask/src/stages.rs` matches `org.projectfile.ci.nodes`
//!   - `spec-check`            Validate `.lean-spec`, `.ears-spec` and `specs/NNNN-*.md`
//!   - `branch-hygiene`        Verify the fork branch model (`main`, `cerebral`, `gitbutler/workspace`, `<type>/<slug>`)
//!   - `cargo-fmt`             `cargo fmt --all -- --check`
//!   - `cargo-clippy`          `cargo clippy -j 2 -p xtask --all-targets -- -D warnings`
//!   - `cargo-test`            `cargo test -j 2 -p xtask`
//!   - `npm-lint`              `npm run lint`
//!   - `npm-test-repo`         `npm run test:repo`
//!   - `npm-test-workspaces`   `npm run test:workspaces`
//!   - `npm-build-package`     `npm run build:package`
//!
//! Commands:
//!   - `hygiene`               Fast zero-compile gates (projectfile, stages, spec, branch)
//!   - `check` | `xwork`       All gates, BLAKE3 content-addressed checkpoints in `target/xtask-cas/`
//!   - `xwork --skip <gate>`   Exclude a gate (repeatable); excluded gates are never recorded as passed
//!   - `xwork --pre-push`      Hygiene plus cargo gates if Rust inputs changed vs the `origin/cerebral` merge-base
//!   - `stack [status]`        Read-only stacked-branch / GitButler status
//!   - any `--break-check`     Falsification self-test: feed each gate a broken input, require red

mod checks;
mod stack;
mod stages;

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};

const TRUNK: &str = "cerebral";

#[derive(Debug, Default, Serialize, Deserialize)]
struct XworkState {
    fingerprint: String,
    updated_at: String,
    passed_gates: BTreeMap<String, String>,
}

fn repo_root() -> Result<PathBuf> {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").context("CARGO_MANIFEST_DIR not set")?;
    Ok(Path::new(&manifest_dir)
        .parent()
        .context("xtask must reside one level below workspace root")?
        .to_path_buf())
}

fn git_out(root: &Path, args: &[&str]) -> Vec<u8> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map(|o| o.stdout)
        .unwrap_or_default()
}

/// BLAKE3 over `HEAD`, branch, `git diff HEAD`, and the bytes of every untracked
/// (non-ignored) file, so any content edit invalidates the checkpoint.
fn workspace_fingerprint(root: &Path) -> Result<String> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(&git_out(root, &["rev-parse", "HEAD"]));
    hasher.update(stack::current_branch_in_process(root)?.as_bytes());
    hasher.update(&git_out(root, &["diff", "HEAD"]));
    let untracked = git_out(root, &["ls-files", "-o", "--exclude-standard", "-z"]);
    for rel in untracked.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        let rel = String::from_utf8_lossy(rel).to_string();
        hasher.update(rel.as_bytes());
        hasher.update(&fs::read(root.join(&rel)).unwrap_or_default());
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn state_file_path(root: &Path) -> PathBuf {
    root.join("target").join(".xwork-state.json")
}

fn cas_receipt_path(root: &Path, fingerprint: &str) -> PathBuf {
    root.join("target")
        .join("xtask-cas")
        .join(format!("{fingerprint}.json"))
}

fn load_state(root: &Path, fingerprint: &str) -> XworkState {
    for path in [cas_receipt_path(root, fingerprint), state_file_path(root)] {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(state) = serde_json::from_str::<XworkState>(&raw) {
                if state.fingerprint == fingerprint {
                    return state;
                }
            }
        }
    }
    XworkState {
        fingerprint: fingerprint.to_string(),
        updated_at: Utc::now().to_rfc3339(),
        passed_gates: BTreeMap::new(),
    }
}

fn save_state(root: &Path, state: &XworkState) -> Result<()> {
    let json = serde_json::to_string_pretty(state)?;
    for path in [
        state_file_path(root),
        cas_receipt_path(root, &state.fingerprint),
    ] {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, &json)?;
    }
    Ok(())
}

fn run_cmd(root: &Path, program: &str, args: &[&str]) -> Result<()> {
    run_cmd_env(root, program, args, &[])
}

fn run_cmd_env(root: &Path, program: &str, args: &[&str], envs: &[(&str, &str)]) -> Result<()> {
    println!("  $ {} {}", program, args.join(" "));
    let status = Command::new(program)
        .args(args)
        .envs(envs.iter().copied())
        .current_dir(root)
        .status()
        .with_context(|| format!("failed to invoke `{program}`"))?;
    if !status.success() {
        bail!(
            "command `{} {}` exited with {}",
            program,
            args.join(" "),
            status
        );
    }
    Ok(())
}

fn execute_gate(root: &Path, gate: &str, break_check: bool) -> Result<()> {
    println!("==> Gate [{gate}]");
    match gate {
        "projectfile-check" => checks::check_projectfile(root, break_check),
        "stages-check" => checks::check_stages(root, break_check),
        "spec-check" => checks::check_specs(root, break_check),
        "branch-hygiene" => checks::check_branch_hygiene(root, break_check),
        "cargo-fmt" => run_cmd(root, "cargo", &["fmt", "--all", "--", "--check"]),
        "cargo-clippy" => run_cmd(
            root,
            "cargo",
            &[
                "clippy",
                "-j",
                "2",
                "-p",
                "xtask",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ],
        ),
        "cargo-test" => run_cmd(root, "cargo", &["test", "-j", "2", "-p", "xtask"]),
        other => match stages::XWORK_STAGES.iter().find(|(n, _)| *n == other) {
            // The repo's fixture tests commit generated `dist/` files; a host-global
            // gitignore that lists `dist/` makes them see "nothing to commit". Blank the
            // global excludes file for this one gate so the result does not depend on the host.
            Some((_, args)) if other == "npm-test-repo" => run_cmd_env(
                root,
                "npm",
                args,
                &[
                    ("GIT_CONFIG_COUNT", "1"),
                    ("GIT_CONFIG_KEY_0", "core.excludesFile"),
                    ("GIT_CONFIG_VALUE_0", "/dev/null"),
                ],
            ),
            Some((_, args)) if other.starts_with("npm-") => run_cmd(root, "npm", args),
            _ => bail!("unknown gate `{other}`"),
        },
    }
}

fn gate_names() -> Vec<&'static str> {
    stages::XWORK_STAGES.iter().map(|(n, _)| *n).collect()
}

fn run_hygiene(root: &Path, break_check: bool) -> Result<()> {
    for gate in stages::HYGIENE_STAGES {
        execute_gate(root, gate, break_check)?;
    }
    Ok(())
}

/// Paths changed relative to the merge-base with `origin/cerebral`, plus the
/// working tree. Works on `gitbutler/workspace`, where `HEAD` is the integration
/// commit and `base..HEAD` spans every applied virtual branch. Fails closed (`None`)
/// when there is no merge-base.
fn changed_paths(root: &Path) -> Option<Vec<String>> {
    let base = String::from_utf8_lossy(&git_out(
        root,
        &["merge-base", &format!("origin/{TRUNK}"), "HEAD"],
    ))
    .trim()
    .to_string();
    if base.is_empty() {
        return None;
    }
    let mut paths: Vec<String> = String::from_utf8_lossy(&git_out(
        root,
        &[
            "diff",
            "--name-only",
            "--diff-filter=ACMRD",
            &format!("{base}..HEAD"),
        ],
    ))
    .lines()
    .map(str::to_string)
    .collect();
    for line in String::from_utf8_lossy(&git_out(root, &["status", "--porcelain"])).lines() {
        if let Some(p) = line.get(3..) {
            paths.push(p.trim().to_string());
        }
    }
    Some(paths)
}

fn rust_inputs_changed(paths: &[String]) -> bool {
    paths.iter().any(|p| {
        p.starts_with("xtask/")
            || p.starts_with(".cargo/")
            || matches!(
                p.as_str(),
                "Cargo.toml" | "Cargo.lock" | "rust-toolchain.toml"
            )
    })
}

fn run_pre_push(root: &Path) -> Result<()> {
    run_hygiene(root, false)?;
    let affected = changed_paths(root).is_none_or(|p| rust_inputs_changed(&p));
    if affected {
        for gate in ["cargo-fmt", "cargo-clippy", "cargo-test"] {
            execute_gate(root, gate, false)?;
        }
    } else {
        println!(
            "pre-push: no Rust inputs changed vs origin/{TRUNK} merge-base, skipping cargo gates"
        );
    }
    println!("pre-push: PASS (npm gates run in CI)");
    Ok(())
}

fn run_xwork(root: &Path, args: &[String]) -> Result<()> {
    if args.iter().any(|a| a == "--pre-push") {
        return run_pre_push(root);
    }
    let break_check = args.iter().any(|a| a == "--break-check");
    let fingerprint = workspace_fingerprint(root)?;
    if args.iter().any(|a| a == "--reset" || a == "--force") {
        for path in [state_file_path(root), cas_receipt_path(root, &fingerprint)] {
            if path.exists() {
                fs::remove_file(&path)?;
            }
        }
        println!("xwork checkpoint state reset.");
    }

    let mut state = load_state(root, &fingerprint);
    let gates = gate_names();

    if args.iter().any(|a| a == "--status") {
        println!("xwork BLAKE3 fingerprint: {}", state.fingerprint);
        for gate in &gates {
            let status = if state.passed_gates.contains_key(*gate) {
                "PASSED (cached)"
            } else {
                "PENDING"
            };
            println!("  - {gate:<22} {status}");
        }
        return Ok(());
    }

    if let Some(pos) = args.iter().position(|a| a == "--only") {
        let gate = args.get(pos + 1).context("`--only` requires a gate name")?;
        execute_gate(root, gate, break_check)?;
        state
            .passed_gates
            .insert(gate.clone(), Utc::now().to_rfc3339());
        state.updated_at = Utc::now().to_rfc3339();
        return save_state(root, &state);
    }

    let mut skipped: Vec<&str> = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if a == "--skip" {
            let gate = args.get(i + 1).context("`--skip` requires a gate name")?;
            if !gates.contains(&gate.as_str()) {
                bail!("`--skip` names unknown gate `{gate}`");
            }
            skipped.push(gate);
        }
    }

    for gate in &gates {
        if skipped.contains(gate) {
            println!("==> Gate [{gate}] SKIP (excluded by --skip; not recorded as passed)");
            continue;
        }
        if !break_check && state.passed_gates.contains_key(*gate) {
            println!(
                "==> Gate [{gate}] SKIP (cached in BLAKE3 CAS {})",
                &fingerprint[..12]
            );
            continue;
        }
        execute_gate(root, gate, break_check)?;
        state
            .passed_gates
            .insert((*gate).to_string(), Utc::now().to_rfc3339());
        state.updated_at = Utc::now().to_rfc3339();
        save_state(root, &state)?;
    }

    if !skipped.is_empty() {
        println!(
            "\nXWORK PASSED with {} gate(s) excluded: {}",
            skipped.len(),
            skipped.join(", ")
        );
        return Ok(());
    }
    println!(
        "\nALL {} OPENRIG XWORK GATES PASSED (BLAKE3 CAS receipt: target/xtask-cas/{}.json)",
        gates.len(),
        &fingerprint[..12]
    );
    Ok(())
}

fn main() -> Result<()> {
    let root = repo_root()?;
    let args: Vec<String> = env::args().skip(1).collect();
    let subcmd = args.first().map(String::as_str).unwrap_or("xwork");
    let break_check = args.iter().any(|a| a == "--break-check");

    match subcmd {
        "stack" => stack::run(&root, &args[1..]),
        "hygiene" => run_hygiene(&root, break_check),
        "check" | "xwork" => run_xwork(&root, &args[1..]),
        other if other.starts_with("--") => run_xwork(&root, &args),
        other if gate_names().contains(&other) => execute_gate(&root, other, break_check),
        other => bail!("unknown xtask command `{other}`"),
    }
}
