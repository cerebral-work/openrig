//! Governance gates: `projectfile-check`, `stages-check`, `spec-check`,
//! `workflow-trigger-check`, `branch-hygiene`. Each validator is a pure function over text so the
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

// ───────────────────────── workflow-trigger-check ─────────────────────────

/// Triggers that run a workflow as `refs/heads/cerebral` on a fork's behalf, so they would match the
/// `ent-parity` runner group's workflow restriction (CER-2908).
pub const FORBIDDEN_TRIGGERS: &[&str] = &["pull_request_target", "workflow_run"];

/// Fails on what the gate cannot read with certainty, anywhere in the file: a custom tag on a key or a value
/// (serde_yaml resolves core tags such as `!!str`), and a merge key `<<`, which GitHub rejects and which,
/// resolved, could let an explicit `on` shadow a merged one.
fn refuse_unreadable(value: &serde_yaml::Value) -> Result<()> {
    use serde_yaml::Value;
    match value {
        Value::Tagged(tagged) => bail!(
            "it uses the custom YAML tag `{}`, which the gate cannot read. Fix: remove the tag; a value \
             that starts with `!`, such as an `if: !cancelled()` expression, must be quoted",
            tagged.tag
        ),
        Value::Mapping(map) => {
            for (key, entry) in map {
                if key.as_str() == Some("<<") {
                    bail!(
                        "it uses a YAML merge key `<<`, which GitHub rejects. Fix: write the merged keys \
                         out in full"
                    );
                }
                refuse_unreadable(key)?;
                refuse_unreadable(entry)?;
            }
            Ok(())
        }
        Value::Sequence(items) => items.iter().try_for_each(refuse_unreadable),
        _ => Ok(()),
    }
}

/// The forbidden triggers one workflow's text declares, in `FORBIDDEN_TRIGGERS` order. Triggers are read
/// from `on` in every form: a scalar, a list, or a map. The key `on` is matched as the string `on` and as
/// boolean `true`: serde_yaml reads `on` as a string, but a YAML 1.1 tool reads it as `true` and writes it
/// back as `true:`. Anything the gate cannot read fails rather than passing as clean: see
/// `refuse_unreadable`, a file with no `on` key, and an `on` value or entry that is not a string.
pub fn forbidden_triggers(raw: &str) -> Result<Vec<&'static str>> {
    use serde_yaml::Value;
    let doc: Value = serde_yaml::from_str(raw)
        .context("it is not valid YAML. Fix: correct the YAML syntax (actionlint shows where)")?;
    refuse_unreadable(&doc)?;
    let mut declared: BTreeSet<String> = BTreeSet::new();
    let mut has_on = false;
    for (key, value) in doc.as_mapping().into_iter().flatten() {
        let is_on =
            matches!(key, Value::String(k) if k == "on") || matches!(key, Value::Bool(true));
        if !is_on {
            continue;
        }
        has_on = true;
        match value {
            Value::String(name) => {
                declared.insert(name.clone());
            }
            Value::Sequence(items) => {
                for item in items {
                    let name = item.as_str().context(
                        "an `on` list entry is not a trigger name. Fix: list trigger names only, and \
                         put trigger settings under an `on` map",
                    )?;
                    declared.insert(name.to_string());
                }
            }
            Value::Mapping(map) => {
                for name in map.keys() {
                    let name = name.as_str().context(
                        "an `on` map key is not a trigger name. Fix: use plain trigger names as `on` keys",
                    )?;
                    declared.insert(name.to_string());
                }
            }
            other => {
                let kind = match other {
                    Value::Null => "empty",
                    Value::Bool(_) => "a bool",
                    Value::Number(_) => "a number",
                    _ => "not a string, a list or a map",
                };
                bail!(
                    "its `on` value is {kind}. Fix: give `on` a trigger name, a list of names or a map"
                );
            }
        }
    }
    if !has_on {
        bail!(
            "it has no `on` key the gate can read. Fix: add a lowercase `on:` key naming its triggers"
        );
    }
    Ok(FORBIDDEN_TRIGGERS
        .iter()
        .copied()
        .filter(|t| declared.contains(*t))
        .collect())
}

/// Every `*.yml` and `*.yaml` file under `dir`, recursively, sorted.
fn workflow_files(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(&current)
            .with_context(|| format!("cannot read `{}`", current.display()))?
        {
            let path = entry?.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.extension().is_some_and(|e| e == "yml" || e == "yaml") {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

/// What the gate reports for one workflow, each line naming the file: every forbidden trigger it declares,
/// or the construct that makes it unreadable, so the gate fails closed.
fn workflow_findings(rel: &str, raw: &str) -> Vec<String> {
    match forbidden_triggers(raw) {
        Ok(triggers) => triggers
            .iter()
            .map(|trigger| {
                format!("`{rel}` declares `{trigger}`. Fix: remove the trigger; use `pull_request` or `push`")
            })
            .collect(),
        Err(err) => vec![format!(
            "`{rel}` cannot be verified, so the gate fails closed: {err:#}"
        )],
    }
}

pub fn check_workflow_triggers(root: &Path, break_check: bool) -> Result<()> {
    let files = workflow_files(&root.join(".github/workflows"))?;
    let mut findings = Vec::new();
    for path in &files {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .display()
            .to_string();
        let raw = fs::read_to_string(path).with_context(|| format!("cannot read `{rel}`"))?;
        findings.extend(workflow_findings(&rel, &raw));
    }
    if !findings.is_empty() {
        bail!(
            "workflow-trigger-check: {}. A `pull_request_target` or `workflow_run` run executes as \
             refs/heads/cerebral, so it would match the ent-parity runner group's workflow restriction and \
             could put fork-influenced code on the self-hosted pool, and a workflow the gate cannot read \
             fails closed (CER-2908)",
            findings.join("; ")
        );
    }
    println!(
        "  workflow-trigger-check PASS: {} workflow file(s), none declares pull_request_target or workflow_run",
        files.len()
    );
    if break_check {
        for (form, yaml) in [
            ("block map", "on:\n  pull_request_target:\n"),
            ("list", "on: [push, workflow_run]\n"),
            ("yaml 1.1 true", "true:\n  pull_request_target:\n"),
        ] {
            if forbidden_triggers(yaml)?.is_empty() {
                bail!("workflow-trigger-check --break-check: a forbidden trigger ({form}) was accepted");
            }
        }
        for (form, yaml) in [
            (
                "merge key",
                "x-t: &t\n  workflow_run:\non:\n  push:\n  <<: *t\n",
            ),
            ("custom tag", "on: !foo pull_request_target\n"),
            ("no on key", "name: x\n"),
        ] {
            if forbidden_triggers(yaml).is_ok() {
                bail!("workflow-trigger-check --break-check: an unreadable workflow ({form}) was accepted");
            }
        }
        if !forbidden_triggers("on: [push, pull_request, workflow_dispatch]\n")?.is_empty() {
            bail!("workflow-trigger-check --break-check: a clean workflow was rejected");
        }
        println!("  workflow-trigger-check --break-check PASS: forbidden triggers and unreadable workflows rejected, a clean workflow accepted");
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

    /// Every trigger form, for both forbidden triggers. `true:` is the YAML 1.1 reading of `on:`, which a
    /// workflow re-serialized by a YAML 1.1 tool (PyYAML, for one) carries.
    const FORBIDDEN_FORMS: &[(&str, &str, &str)] = &[
        ("scalar", "on: pull_request_target\n", "pull_request_target"),
        ("scalar", "on: workflow_run\n", "workflow_run"),
        (
            "list",
            "on: [push, pull_request_target]\n",
            "pull_request_target",
        ),
        ("list", "on: [push, workflow_run]\n", "workflow_run"),
        (
            "flow map",
            "on: {pull_request_target: {types: [opened]}}\n",
            "pull_request_target",
        ),
        (
            "flow map",
            "on: {workflow_run: {workflows: [ci]}}\n",
            "workflow_run",
        ),
        (
            "block map",
            "on:\n  push:\n  pull_request_target:\n    types: [opened]\n",
            "pull_request_target",
        ),
        (
            "block map",
            "on:\n  push:\n  workflow_run:\n    workflows: [ci]\n",
            "workflow_run",
        ),
        (
            "quoted on",
            "\"on\":\n  pull_request_target:\n",
            "pull_request_target",
        ),
        ("quoted on", "\"on\": [workflow_run]\n", "workflow_run"),
        (
            "yaml 1.1 true",
            "true:\n  pull_request_target:\n",
            "pull_request_target",
        ),
        (
            "yaml 1.1 true",
            "true: [push, workflow_run]\n",
            "workflow_run",
        ),
        (
            "alias",
            "x-t: &t pull_request_target\non: *t\n",
            "pull_request_target",
        ),
        (
            "core str tag on the key, block map",
            "!!str on:\n  pull_request_target:\n    types: [opened]\n",
            "pull_request_target",
        ),
        (
            "alias for a map anchor",
            "x-trig: &trig\n  pull_request_target:\n    types: [opened]\non: *trig\n",
            "pull_request_target",
        ),
        (
            "alias for a list anchor",
            "x-trig: &trig [push, workflow_run]\non: *trig\n",
            "workflow_run",
        ),
        (
            "alias as a list entry",
            "x-t: &t workflow_run\non: [push, *t]\n",
            "workflow_run",
        ),
        (
            "alias as an on map key",
            "x-t: &t pull_request_target\non:\n  push:\n  *t :\n    types: [opened]\n",
            "pull_request_target",
        ),
        (
            "alias as the on key",
            "x-k: &k on\n*k : pull_request_target\n",
            "pull_request_target",
        ),
        (
            "anchor inside on",
            "on:\n  push: &p\n    branches: [cerebral]\n  workflow_run: *p\n",
            "workflow_run",
        ),
    ];

    #[test]
    fn workflow_trigger_every_forbidden_form_is_caught() {
        for (form, yaml, want) in FORBIDDEN_FORMS {
            assert_eq!(
                forbidden_triggers(yaml).unwrap(),
                vec![*want],
                "{form}: {yaml:?}"
            );
        }
    }

    #[test]
    fn workflow_trigger_clean_workflow_passes() {
        let clean = "on:\n  pull_request:\n    branches: [cerebral]\n  push:\n    branches: [cerebral]\n  workflow_dispatch:\njobs: {}\n";
        assert!(forbidden_triggers(clean).unwrap().is_empty());
    }

    #[test]
    fn workflow_trigger_both_triggers_are_named() {
        let both = "on:\n  workflow_run:\n    workflows: [ci]\n  pull_request_target:\n";
        assert_eq!(
            forbidden_triggers(both).unwrap(),
            vec!["pull_request_target", "workflow_run"]
        );
    }

    /// What serde_yaml 0.9 does with the keys: a YAML 1.2 core schema, so `on` stays a string and only
    /// `true` is a boolean. The check accepts both readings.
    #[test]
    fn serde_yaml_reads_on_as_a_string_and_true_as_a_bool() {
        let doc: serde_yaml::Value = serde_yaml::from_str("on: push\ntrue: x\n").unwrap();
        let keys: Vec<serde_yaml::Value> = doc.as_mapping().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            vec![
                serde_yaml::Value::String("on".into()),
                serde_yaml::Value::Bool(true)
            ]
        );
    }

    #[test]
    fn workflow_trigger_malformed_yaml_is_rejected() {
        assert!(forbidden_triggers("on: [push\n").is_err());
    }

    /// GitHub rejects merge keys, and resolving one could let an explicit `on` shadow a merged one, so any
    /// `<<` key fails, wherever it is and whatever it brings in.
    const MERGE_KEY_FORMS: &[(&str, &str)] = &[
        (
            "top level",
            "x-base: &base\n  on: pull_request_target\n<<: *base\njobs: {}\n",
        ),
        (
            "inside on",
            "x-t: &t\n  workflow_run:\n    workflows: [ci]\non:\n  push:\n  <<: *t\n",
        ),
        (
            "list",
            "x-a: &a\n  push:\nx-b: &b\n  pull_request_target:\non:\n  <<: [*a, *b]\n",
        ),
        ("harmless", "x-a: &a\n  push:\non:\n  <<: *a\n"),
    ];

    #[test]
    fn workflow_trigger_merge_keys_are_refused() {
        for (form, yaml) in MERGE_KEY_FORMS {
            let err = forbidden_triggers(yaml).expect_err(form);
            assert!(format!("{err:#}").contains("merge key"), "{form}: {err:#}");
        }
    }

    /// A custom tag on a key, a value or a list entry, or anywhere else in the file, fails.
    const CUSTOM_TAG_FORMS: &[(&str, &str)] = &[
        ("value", "on: !foo pull_request_target\n"),
        ("key", "!foo on: pull_request_target\n"),
        ("list entry", "on: [push, !foo workflow_run]\n"),
        ("elsewhere", "on: push\njobs: !foo {}\n"),
    ];

    #[test]
    fn workflow_trigger_custom_tags_are_refused() {
        for (form, yaml) in CUSTOM_TAG_FORMS {
            let err = forbidden_triggers(yaml).expect_err(form);
            assert!(format!("{err:#}").contains("`!foo`"), "{form}: {err:#}");
        }
    }

    /// The core `!!str` tag is not refused: serde_yaml reads it as a plain string, so the trigger is named.
    #[test]
    fn workflow_trigger_core_str_tag_reads_as_a_string() {
        assert_eq!(
            forbidden_triggers("on: !!str pull_request_target\n").unwrap(),
            vec!["pull_request_target"]
        );
        assert_eq!(
            forbidden_triggers("!!str on: [workflow_run]\n").unwrap(),
            vec!["workflow_run"]
        );
    }

    /// An `on` the gate cannot read fails instead of passing as clean.
    const UNREADABLE_ON_FORMS: &[(&str, &str)] = &[
        ("no on key", "name: x\njobs: {}\n"),
        ("capitalised On", "On: pull_request_target\n"),
        ("empty file", ""),
        ("null on", "on:\njobs: {}\n"),
        ("number on", "on: 5\n"),
        ("bool on", "on: true\n"),
        ("map in on list", "on: [push, {pull_request_target: {}}]\n"),
        (
            "list as on map key",
            "on:\n  ? [pull_request_target]\n  : x\n",
        ),
    ];

    #[test]
    fn workflow_trigger_unreadable_on_is_refused() {
        for (form, yaml) in UNREADABLE_ON_FORMS {
            assert!(forbidden_triggers(yaml).is_err(), "{form}: {yaml:?}");
        }
    }

    /// Every finding names the file, the construct and the fix.
    const FINDING_TEXTS: &[(&str, &str, &str)] = &[
        (
            "on: workflow_run\n",
            "declares `workflow_run`",
            "remove the trigger",
        ),
        (
            "on: !foo push\n",
            "custom YAML tag `!foo`",
            "must be quoted",
        ),
        (
            "x-a: &a\n  push:\non:\n  <<: *a\n",
            "merge key `<<`",
            "write the merged keys out",
        ),
        ("name: x\n", "no `on` key", "add a lowercase `on:`"),
        ("on:\n", "`on` value is empty", "give `on` a trigger name"),
        (
            "on: 5\n",
            "`on` value is a number",
            "give `on` a trigger name",
        ),
        (
            "on: true\n",
            "`on` value is a bool",
            "give `on` a trigger name",
        ),
        (
            "on: [push, {a: b}]\n",
            "`on` list entry",
            "list trigger names only",
        ),
        (
            "on:\n  ? [a]\n  : x\n",
            "`on` map key",
            "plain trigger names",
        ),
        ("on: [push\n", "not valid YAML", "correct the YAML syntax"),
    ];

    #[test]
    fn workflow_trigger_findings_name_file_construct_and_fix() {
        for (yaml, construct, fix) in FINDING_TEXTS {
            let findings = workflow_findings("w.yml", yaml);
            assert_eq!(findings.len(), 1, "{yaml:?}: {findings:?}");
            let line = &findings[0];
            for part in ["`w.yml`", construct, "Fix:", fix] {
                assert!(line.contains(part), "{yaml:?}: missing {part:?} in {line}");
            }
        }
    }

    /// The repository's own workflows pass, so a false positive goes red here, before a parity push.
    #[test]
    fn workflow_trigger_real_workflows_pass() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("xtask sits in the repo root");
        let files = workflow_files(&root.join(".github/workflows")).unwrap();
        assert!(
            files.iter().any(|f| f.ends_with("estate-xwork.yml")),
            "the walk missed the real workflows: {files:?}"
        );
        for path in &files {
            let raw = fs::read_to_string(path).unwrap();
            let findings = workflow_findings(&path.display().to_string(), &raw);
            assert!(findings.is_empty(), "{findings:?}");
        }
    }
}
