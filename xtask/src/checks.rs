//! Governance gates: `projectfile-check`, `stages-check`, `spec-check`,
//! `branch-hygiene`. Each validator is a pure function over text so the
//! `--break-check` falsification self-test can feed it a deliberately broken
//! input and require a failure.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use crate::stack;
use crate::stages;

const SCHEMA_URL: &str = "https://projectfile.org/schema/v1.json";
const NAMESPACE: &str = "io.todie.cerebral";
const NAME: &str = "openrig";

// ───────────────────────── projectfile-check ─────────────────────────

#[derive(Debug, Deserialize)]
struct Identity {
    namespace: String,
    name: String,
    version: String,
}

#[derive(Debug, Deserialize)]
struct Repository {
    url: String,
    branch: Option<String>,
    role: String,
}

#[derive(Debug, Deserialize)]
struct Projectfile {
    #[serde(rename = "$schema")]
    schema: String,
    kind: String,
    identity: Identity,
    repositories: Vec<Repository>,
}

/// Validate `projectfile.yaml` text against the estate rules; `expected_version`
/// is the version shipped by `packages/cli/package.json`.
pub fn validate_projectfile(raw: &str, expected_version: &str) -> Result<String> {
    let doc: Projectfile =
        serde_yaml::from_str(raw).context("invalid YAML or missing keys in `projectfile.yaml`")?;
    if doc.schema != SCHEMA_URL {
        bail!("`projectfile.yaml` must reference `{SCHEMA_URL}`");
    }
    if doc.kind != "SoftwareSourceCode" {
        bail!("`projectfile.yaml` kind must be `SoftwareSourceCode`");
    }
    if doc.identity.namespace != NAMESPACE || doc.identity.name != NAME {
        bail!("`projectfile.yaml` identity must be `{NAMESPACE}:{NAME}`");
    }
    if doc.identity.version != expected_version {
        bail!(
            "`projectfile.yaml` version ({}) does not match packages/cli/package.json ({expected_version})",
            doc.identity.version
        );
    }
    let find = |role: &str| doc.repositories.iter().find(|r| r.role == role);
    let origin = find("origin").ok_or_else(|| anyhow!("repositories: missing role `origin`"))?;
    if !origin.url.contains("cerebral-work/openrig") || origin.branch.as_deref() != Some("cerebral")
    {
        bail!("repositories: `origin` must be cerebral-work/openrig on branch `cerebral`");
    }
    let upstream =
        find("upstream").ok_or_else(|| anyhow!("repositories: missing role `upstream`"))?;
    if !upstream.url.contains("mvschwarz/openrig") {
        bail!("repositories: `upstream` must be mvschwarz/openrig");
    }
    Ok(format!(
        "{}:{} v{} ({})",
        doc.identity.namespace, doc.identity.name, doc.identity.version, doc.kind
    ))
}

fn cli_version(root: &Path) -> Result<String> {
    let raw = fs::read_to_string(root.join("packages/cli/package.json"))
        .context("missing `packages/cli/package.json`")?;
    let v: serde_json::Value = serde_json::from_str(&raw).context("invalid package.json")?;
    v.get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("packages/cli/package.json has no `version`"))
}

pub fn check_projectfile(root: &Path, break_check: bool) -> Result<()> {
    let raw =
        fs::read_to_string(root.join("projectfile.yaml")).context("missing `projectfile.yaml`")?;
    let summary = validate_projectfile(&raw, &cli_version(root)?)?;
    println!("  projectfile-check PASS: {summary}");
    if break_check {
        let broken = format!("{raw}\n  : [unbalanced");
        if validate_projectfile(&broken, &cli_version(root)?).is_ok() {
            bail!("projectfile-check --break-check: malformed YAML was accepted");
        }
        let wrong = raw.replace("name: openrig", "name: not-openrig");
        if validate_projectfile(&wrong, &cli_version(root)?).is_ok() {
            bail!("projectfile-check --break-check: wrong identity was accepted");
        }
        println!("  projectfile-check --break-check PASS: broken inputs rejected");
    }
    Ok(())
}

// ───────────────────────── stages-check ─────────────────────────

/// Leaf gate names in topological order derived from `org.projectfile.ci.nodes`.
pub fn ci_leaves(raw: &str) -> Result<Vec<String>> {
    let doc: serde_yaml::Value = serde_yaml::from_str(raw).context("invalid projectfile YAML")?;
    let nodes = doc
        .get("org")
        .and_then(|v| v.get("projectfile"))
        .and_then(|v| v.get("ci"))
        .and_then(|v| v.get("nodes"))
        .and_then(serde_yaml::Value::as_mapping)
        .ok_or_else(|| anyhow!("`org.projectfile.ci.nodes` is missing"))?;
    let node_names: BTreeSet<String> = nodes
        .keys()
        .filter_map(|k| k.as_str().map(str::to_string))
        .collect();
    let mut leaves: Vec<String> = Vec::new();
    for (name, node) in nodes {
        let name = name.as_str().unwrap_or_default();
        let needs = node
            .get("needs")
            .and_then(serde_yaml::Value::as_mapping)
            .ok_or_else(|| anyhow!("ci node `{name}` has no `needs`"))?;
        for need in needs.keys().filter_map(serde_yaml::Value::as_str) {
            if !node_names.contains(need) && !leaves.iter().any(|l| l == need) {
                leaves.push(need.to_string());
            }
        }
    }
    Ok(leaves)
}

/// Compare the projectfile DAG leaves with the lowered `stages` table.
pub fn validate_stages(raw: &str, lowered: &[&str]) -> Result<()> {
    let leaves = ci_leaves(raw)?;
    let lowered: Vec<String> = lowered.iter().map(|s| (*s).to_string()).collect();
    if leaves != lowered {
        bail!(
            "`xtask/src/stages.rs` stages {lowered:?} do not match `projectfile.yaml` ci leaves {leaves:?}"
        );
    }
    Ok(())
}

pub fn check_stages(root: &Path, break_check: bool) -> Result<()> {
    let raw =
        fs::read_to_string(root.join("projectfile.yaml")).context("missing `projectfile.yaml`")?;
    let names: Vec<&str> = stages::XWORK_STAGES.iter().map(|(n, _)| *n).collect();
    validate_stages(&raw, &names)?;
    if stages::DEFAULT_JOBS != 2 {
        bail!("`stages::DEFAULT_JOBS` must be 2 on host ceres");
    }
    for h in stages::HYGIENE_STAGES {
        if !names.contains(h) {
            bail!("hygiene stage `{h}` is not an xwork stage");
        }
    }
    println!(
        "  stages-check PASS: {} lowered CI stages match `projectfile.yaml` (DEFAULT_JOBS = {})",
        names.len(),
        stages::DEFAULT_JOBS
    );
    if break_check {
        let mut dropped = names.clone();
        dropped.pop();
        let mut extra = names.clone();
        extra.push("bogus-stage");
        if validate_stages(&raw, &dropped).is_ok() || validate_stages(&raw, &extra).is_ok() {
            bail!("stages-check --break-check: a mismatched stage table was accepted");
        }
        println!("  stages-check --break-check PASS: dropped and extra stages rejected");
    }
    Ok(())
}

// ───────────────────────── spec-check ─────────────────────────

#[derive(Debug, Deserialize)]
struct EarsConfig {
    spec_dir: String,
    ears_from: String,
    require_req_ids: bool,
    require_single_shall: bool,
    max_lines_warn: usize,
    max_lines_error: usize,
}

/// Validate one `specs/NNNN-*.md` document (LeanSpec sections + EARS requirements).
pub fn validate_spec(name: &str, content: &str, cfg: &SpecRules) -> Result<usize> {
    if !content.starts_with("---\n") {
        bail!("spec `{name}` is missing YAML frontmatter");
    }
    for key in ["status:", "created:", "priority:"] {
        if !content.contains(key) {
            bail!("spec `{name}` frontmatter is missing `{key}`");
        }
    }
    for section in [
        "## Overview",
        "## Design",
        "## Requirements",
        "## Plan",
        "## Test",
    ] {
        if !content.contains(section) {
            bail!("spec `{name}` is missing required LeanSpec section `{section}`");
        }
    }
    let lines = content.lines().count();
    if lines > cfg.max_lines_error {
        bail!(
            "spec `{name}` has {lines} lines (> {})",
            cfg.max_lines_error
        );
    }
    if lines > cfg.max_lines_warn {
        println!(
            "  spec-check WARN: `{name}` has {lines} lines (> {})",
            cfg.max_lines_warn
        );
    }
    let number = name.split('-').next().unwrap_or_default();
    let ears_applies = number >= cfg.ears_from.as_str();
    let reqs: Vec<&str> = content
        .lines()
        .filter(|l| l.starts_with("- REQ-"))
        .collect();
    if ears_applies && reqs.is_empty() {
        bail!("spec `{name}` must contain at least one `- REQ-NNNN-NN:` requirement");
    }
    let mut seen = BTreeSet::new();
    for (i, line) in reqs.iter().enumerate() {
        let id = line
            .trim_start_matches("- ")
            .split(':')
            .next()
            .unwrap_or_default();
        let parts: Vec<&str> = id.split('-').collect();
        let well_formed = parts.len() == 3
            && parts[0] == "REQ"
            && parts[1] == number
            && parts[2].len() == 2
            && parts[2].chars().all(|c| c.is_ascii_digit());
        if cfg.require_req_ids && !well_formed {
            bail!(
                "spec `{name}` requirement #{} has malformed id `{id}` (want REQ-{number}-NN)",
                i + 1
            );
        }
        if !seen.insert(id.to_string()) {
            bail!("spec `{name}` repeats requirement id `{id}`");
        }
        let shalls = line.to_ascii_lowercase().matches(" shall ").count();
        if cfg.require_single_shall && shalls != 1 {
            bail!("spec `{name}` requirement `{id}` must contain exactly one `shall` (found {shalls})");
        }
    }
    Ok(reqs.len())
}

pub struct SpecRules {
    ears_from: String,
    require_req_ids: bool,
    require_single_shall: bool,
    max_lines_warn: usize,
    max_lines_error: usize,
}

pub fn check_specs(root: &Path, break_check: bool) -> Result<()> {
    if !root.join(".lean-spec").is_file() {
        bail!("missing `.lean-spec` at workspace root");
    }
    let ears_raw = fs::read_to_string(root.join(".ears-spec")).context("missing `.ears-spec`")?;
    let ears: EarsConfig = toml::from_str(&ears_raw).context("invalid `.ears-spec` TOML")?;
    let rules = SpecRules {
        ears_from: ears.ears_from.clone(),
        require_req_ids: ears.require_req_ids,
        require_single_shall: ears.require_single_shall,
        max_lines_warn: ears.max_lines_warn,
        max_lines_error: ears.max_lines_error,
    };
    let dir = root.join(&ears.spec_dir);
    let readme = fs::read_to_string(dir.join("README.md"))
        .with_context(|| format!("missing `{}/README.md`", ears.spec_dir))?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("cannot read `{}/`", ears.spec_dir))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        let numbered = name.len() > 5
            && name[..4].chars().all(|c| c.is_ascii_digit())
            && name.as_bytes()[4] == b'-'
            && name.ends_with(".md");
        if numbered {
            files.push((name, entry.path()));
        } else if name != "README.md" {
            bail!("`{}/{name}` is not named `NNNN-slug.md`", ears.spec_dir);
        }
    }
    files.sort();
    if files.is_empty() {
        bail!("no numbered spec files found in `{}/`", ears.spec_dir);
    }
    let mut total = 0;
    for (name, path) in &files {
        if !readme.contains(name.as_str()) {
            bail!("`{}/README.md` does not index `{name}`", ears.spec_dir);
        }
        total += validate_spec(name, &fs::read_to_string(path)?, &rules)?;
    }
    println!(
        "  spec-check PASS: {} spec(s), {total} EARS requirement(s) verified (.lean-spec & .ears-spec present)",
        files.len()
    );
    if break_check {
        let (name, path) = &files[0];
        let good = fs::read_to_string(path)?;
        let no_shall = good.replace(" shall ", " will ");
        let no_section = good.replace("## Requirements", "## Reqs");
        let dup = format!(
            "{good}\n- REQ-{}-01: The system shall repeat an id.\n",
            &name[..4]
        );
        for (label, text) in [
            ("no shall", no_shall),
            ("no section", no_section),
            ("duplicate id", dup),
        ] {
            if validate_spec(name, &text, &rules).is_ok() {
                bail!("spec-check --break-check: broken spec ({label}) was accepted");
            }
        }
        println!("  spec-check --break-check PASS: broken specs rejected");
    }
    Ok(())
}

// ───────────────────────── branch-hygiene ─────────────────────────

const BRANCH_PREFIXES: &[&str] = &[
    "feat/",
    "fix/",
    "chore/",
    "docs/",
    "refactor/",
    "test/",
    "ci/",
    "perf/",
    "build/",
    "stack/",
    "cw/",
    "up/",
    "release/",
    "revert/",
    "gitbutler/",
];

/// Fork branch model: `main` (upstream mirror), `cerebral` (distribution),
/// `gitbutler/workspace`, `<type>/<slug>` feature branches, or a detached SHA.
pub fn branch_is_valid(branch: &str) -> bool {
    let slug_ok = |rest: &str| {
        !rest.is_empty()
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
    };
    matches!(branch, "main" | "cerebral" | "HEAD")
        || BRANCH_PREFIXES
            .iter()
            .any(|p| branch.strip_prefix(p).is_some_and(slug_ok))
        || (branch.len() >= 7 && branch.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn check_branch_hygiene(root: &Path, break_check: bool) -> Result<()> {
    let branch = stack::current_branch_in_process(root)?;
    if !branch_is_valid(&branch) {
        bail!(
            "branch `{branch}` violates the fork branch model (`main`, `cerebral`, `gitbutler/workspace`, or `<type>/<slug>` with type in feat fix chore docs refactor test ci perf build stack cw up release revert)"
        );
    }
    println!("  branch-hygiene PASS: current ref `{branch}` conforms to the fork branch model");
    if break_check {
        for bad in [
            "Feature-Branch",
            "wip",
            "feat/",
            "feat/has space",
            "master",
            "random/x",
        ] {
            if branch_is_valid(bad) {
                bail!("branch-hygiene --break-check: invalid branch `{bad}` was accepted");
            }
        }
        for good in [
            "main",
            "cerebral",
            "gitbutler/workspace",
            "feat/estate-xtask",
            "up/fix-x",
        ] {
            if !branch_is_valid(good) {
                bail!("branch-hygiene --break-check: valid branch `{good}` was rejected");
            }
        }
        println!(
            "  branch-hygiene --break-check PASS: invalid names rejected, valid names accepted"
        );
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn branch_rules() {
        assert!(branch_is_valid("gitbutler/workspace"));
        assert!(branch_is_valid("cerebral"));
        assert!(branch_is_valid("up/feature-x"));
        assert!(!branch_is_valid("master"));
        assert!(!branch_is_valid("feat/"));
    }

    #[test]
    fn stages_mismatch_is_rejected() {
        let pf = "org:\n  projectfile:\n    ci:\n      nodes:\n        a:\n          needs:\n            x: true\n            y: true\n";
        assert!(validate_stages(pf, &["x", "y"]).is_ok());
        assert!(validate_stages(pf, &["x"]).is_err());
        assert!(validate_stages(pf, &["y", "x"]).is_err());
    }

    #[test]
    fn malformed_projectfile_is_rejected() {
        assert!(validate_projectfile("not: [valid", "1.0.0").is_err());
    }
}
