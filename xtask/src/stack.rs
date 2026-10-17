//! `cargo xtask stack [status|base-ref]` — read-only stacked-branch / GitButler status.
//!
//! The fork trunk is `cerebral` (distribution branch). Reference discovery
//! (`.git/HEAD`, `refs/heads/*`, `packed-refs`) runs in-process without shelling
//! out to `git`. Under `gitbutler/workspace` the output of `but status` is
//! appended. Nothing here mutates the repository; use `but` (GitButler SOP)
//! for branch creation, pushes and PRs.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};

const DEFAULT_TRUNK: &str = "cerebral";

/// Resolve the `.git` directory for `root` (handles both standard repos and worktrees).
fn resolve_git_dir(root: &Path) -> Result<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    if dot_git.is_file() {
        let raw = fs::read_to_string(&dot_git)
            .with_context(|| format!("failed to read {}", dot_git.display()))?;
        if let Some(rest) = raw.trim().strip_prefix("gitdir:") {
            let gitdir = PathBuf::from(rest.trim());
            let resolved = if gitdir.is_relative() {
                root.join(gitdir)
            } else {
                gitdir
            };
            return Ok(resolved);
        }
    }
    bail!("could not locate `.git` directory at {}", root.display())
}

/// Resolve the common `.git` directory (for worktrees where `commondir` points to the main repo).
fn resolve_common_git_dir(git_dir: &Path) -> PathBuf {
    let commondir_file = git_dir.join("commondir");
    if let Ok(raw) = fs::read_to_string(&commondir_file) {
        let rel = raw.trim();
        if !rel.is_empty() {
            let candidate = git_dir.join(rel);
            if let Ok(canon) = candidate.canonicalize() {
                return canon;
            }
            return candidate;
        }
    }
    git_dir.to_path_buf()
}

/// Read the current branch short name from `.git/HEAD` in-process.
pub fn current_branch_in_process(root: &Path) -> Result<String> {
    let git_dir = resolve_git_dir(root)?;
    let head_raw = fs::read_to_string(git_dir.join("HEAD")).context("failed to read .git/HEAD")?;
    let trimmed = head_raw.trim();
    if let Some(ref_path) = trimmed.strip_prefix("ref: ") {
        if let Some(branch) = ref_path.strip_prefix("refs/heads/") {
            return Ok(branch.to_string());
        }
        return Ok(ref_path.to_string());
    }
    Ok(trimmed.chars().take(12).collect())
}

/// Collect all local branch refs (`refs/heads/<name>` -> `<oid>`) in-process.
pub fn list_local_branches_in_process(root: &Path) -> Result<BTreeMap<String, String>> {
    let git_dir = resolve_git_dir(root)?;
    let common_dir = resolve_common_git_dir(&git_dir);
    let mut branches = BTreeMap::new();

    let packed = common_dir.join("packed-refs");
    if let Ok(raw) = fs::read_to_string(&packed) {
        for line in raw.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with('^') {
                continue;
            }
            let mut parts = line.split_whitespace();
            if let (Some(oid), Some(refname)) = (parts.next(), parts.next()) {
                if let Some(short) = refname.strip_prefix("refs/heads/") {
                    branches.insert(short.to_string(), oid.to_string());
                }
            }
        }
    }

    let heads_dir = common_dir.join("refs/heads");
    if heads_dir.is_dir() {
        walk_loose_refs(&heads_dir, &heads_dir, &mut branches)?;
    }

    Ok(branches)
}

fn walk_loose_refs(
    base: &Path,
    dir: &Path,
    out: &mut BTreeMap<String, String>,
) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            walk_loose_refs(base, &path, out)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                let name = rel.to_string_lossy().replace('\\', "/");
                if let Ok(oid) = fs::read_to_string(&path) {
                    out.insert(name, oid.trim().to_string());
                }
            }
        }
    }
    Ok(())
}

/// Read the recorded parent branch for `branch` from `.git/stack/<branch>.base`
/// (written by earlier tooling), defaulting to the trunk `cerebral`.
pub fn resolve_base_ref(root: &Path, branch: &str) -> Result<String> {
    if branch == DEFAULT_TRUNK || branch == "main" || branch == "gitbutler/workspace" {
        return Ok(DEFAULT_TRUNK.to_string());
    }
    let git_dir = resolve_git_dir(root)?;
    let common_dir = resolve_common_git_dir(&git_dir);
    let stack_meta = common_dir
        .join("stack")
        .join(format!("{}.base", branch.replace('/', "__")));
    if let Ok(parent) = fs::read_to_string(&stack_meta) {
        let parent = parent.trim();
        if !parent.is_empty() {
            return Ok(parent.to_string());
        }
    }
    Ok(DEFAULT_TRUNK.to_string())
}

fn ahead_behind(root: &Path, base: &str, head: &str) -> Option<(u32, u32)> {
    let out = Command::new("git")
        .current_dir(root)
        .args([
            "rev-list",
            "--left-right",
            "--count",
            &format!("{base}...{head}"),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split_whitespace();
    let behind: u32 = parts.next()?.parse().ok()?;
    let ahead: u32 = parts.next()?.parse().ok()?;
    Some((ahead, behind))
}

/// Entrypoint for `cargo xtask stack <subcommand>`.
pub fn run(root: &Path, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str).unwrap_or("status") {
        "status" => cmd_status(root),
        "base-ref" => {
            let branch = current_branch_in_process(root)?;
            println!("{}", resolve_base_ref(root, &branch)?);
            Ok(())
        }
        other => {
            bail!("unknown `cargo xtask stack` subcommand `{other}` (read-only: status, base-ref)")
        }
    }
}

fn cmd_status(root: &Path) -> Result<()> {
    let current = current_branch_in_process(root)?;
    let branches = list_local_branches_in_process(root)?;
    let base = resolve_base_ref(root, &current)?;

    println!("Stack status ({}):", root.display());
    println!("  current branch : {current}");
    println!("  trunk          : {DEFAULT_TRUNK} (distribution branch; GitButler target origin/{DEFAULT_TRUNK})");
    println!("  parent base-ref: {base}");
    let remote_base = format!("origin/{DEFAULT_TRUNK}");
    if let Some((ahead, behind)) = ahead_behind(root, &remote_base, "HEAD") {
        println!("  divergence     : +{ahead} ahead / -{behind} behind `{remote_base}`");
    }
    println!("  local branches ({}):", branches.len());
    for (name, oid) in &branches {
        let marker = if name == &current { "*" } else { " " };
        let short_oid: String = oid.chars().take(10).collect();
        let role = match name.as_str() {
            "main" => "upstream mirror (ff-only)",
            DEFAULT_TRUNK => "trunk",
            _ => "",
        };
        println!("  {marker} {name:<32} {short_oid} {role}");
    }
    if current == "gitbutler/workspace" {
        println!("  GitButler workspace (`but status`):");
        match Command::new("but").current_dir(root).arg("status").output() {
            Ok(out) if out.status.success() => {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    println!("    {line}");
                }
            }
            _ => println!("    (`but status` unavailable)"),
        }
    }
    Ok(())
}
