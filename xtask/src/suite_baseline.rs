//! `cargo xtask suite-baseline`: the full-suite job's known-failure baseline (spec 0001 item 8, CER-2937).
//!
//!   - `workspaces`        Print the workspaces `npm run test:workspaces` names, one per line
//!   - `check --reports <dir> [--baseline <file>]`: compare each workspace's reports with the baseline
//!     (default `.github/full-suite-baseline.json`)
//!
//! For a workspace `packages/<ws>`, the reports directory holds `<ws>.json` (vitest's JSON reporter),
//! `<ws>.unhandled.json` (`.github/full-suite/unhandled-reporter.mjs`) and `<ws>.exit` (the suite's exit code).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

pub const DEFAULT_BASELINE: &str = ".github/full-suite-baseline.json";
/// The test of a file that failed without a failed test: an import error or a failed hook.
pub const FILE_TEST: &str = "(file)";
/// The test of a workspace's unhandled errors; the entry's file is the workspace directory.
pub const UNHANDLED_TEST: &str = "(unhandled errors)";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Key {
    pub file: String,
    pub test: String,
}

impl std::fmt::Display for Key {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} :: {}", self.file, self.test)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Fails,
    Flaky,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub file: String,
    pub test: String,
    pub kind: Kind,
    pub reason: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub version: u32,
    pub entries: Vec<Entry>,
}

/// What the reports show: every key that failed, and every key that passed and didn't also fail.
#[derive(Debug, Default)]
pub struct Outcomes {
    pub failed: BTreeSet<Key>,
    pub passed: BTreeSet<Key>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    pub errors: Vec<String>,
    pub notices: Vec<String>,
}

#[derive(Deserialize)]
struct Report {
    #[serde(rename = "testResults")]
    test_results: Vec<FileResult>,
}

#[derive(Deserialize)]
struct FileResult {
    name: String,
    status: String,
    #[serde(rename = "assertionResults", default)]
    assertion_results: Vec<Assertion>,
}

#[derive(Deserialize)]
struct Assertion {
    #[serde(rename = "ancestorTitles", default)]
    ancestor_titles: Vec<String>,
    title: String,
    status: String,
}

#[derive(Deserialize)]
struct Unhandled {
    count: usize,
}

/// The workspaces `test:workspaces` runs, from its `-w`/`--workspace` arguments.
pub fn parse_workspaces(package_json: &str) -> Result<Vec<String>> {
    let value: serde_json::Value =
        serde_json::from_str(package_json).context("package.json is not JSON")?;
    let script = value
        .pointer("/scripts/test:workspaces")
        .and_then(serde_json::Value::as_str)
        .context("package.json has no `test:workspaces` script")?;
    let tokens: Vec<&str> = script.split_whitespace().collect();
    let mut workspaces = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        if let Some(ws) = token.strip_prefix("--workspace=") {
            workspaces.push(ws.to_string());
        } else if matches!(*token, "-w" | "--workspace") {
            let ws = tokens.get(i + 1).context("`-w` without a workspace")?;
            workspaces.push((*ws).to_string());
        }
    }
    if workspaces.is_empty() {
        bail!("`test:workspaces` names no workspace: {script}");
    }
    Ok(workspaces)
}

/// One workspace's outcomes from its vitest JSON report and unhandled-error count. File names in the report
/// are absolute; `root` is stripped to make them repository-relative.
pub fn workspace_outcomes(
    root: &str,
    workspace: &str,
    report: &str,
    unhandled: &str,
) -> Result<Outcomes> {
    let report: Report =
        serde_json::from_str(report).context("the vitest report is not readable")?;
    let unhandled: Unhandled =
        serde_json::from_str(unhandled).context("the unhandled-error report is not readable")?;
    let prefix = format!("{}/", root.trim_end_matches('/'));
    let mut out = Outcomes::default();
    for file in &report.test_results {
        let rel = file
            .name
            .strip_prefix(&prefix)
            .with_context(|| format!("the report names `{}`, outside `{root}`", file.name))?;
        let mut a_test_failed = false;
        for assertion in &file.assertion_results {
            let mut titles = assertion.ancestor_titles.clone();
            titles.push(assertion.title.clone());
            let key = Key {
                file: rel.to_string(),
                test: titles.join(" > "),
            };
            match assertion.status.as_str() {
                "failed" => {
                    a_test_failed = true;
                    out.failed.insert(key);
                }
                "passed" => {
                    out.passed.insert(key);
                }
                _ => {}
            }
        }
        let file_key = Key {
            file: rel.to_string(),
            test: FILE_TEST.to_string(),
        };
        match file.status.as_str() {
            "failed" if !a_test_failed => {
                out.failed.insert(file_key);
            }
            "passed" => {
                out.passed.insert(file_key);
            }
            _ => {}
        }
    }
    let unhandled_key = Key {
        file: workspace.to_string(),
        test: UNHANDLED_TEST.to_string(),
    };
    if unhandled.count > 0 {
        out.failed.insert(unhandled_key);
    } else {
        out.passed.insert(unhandled_key);
    }
    let failed = out.failed.clone();
    out.passed.retain(|key| !failed.contains(key));
    Ok(out)
}

/// Every problem with the baseline's entries; empty when it is valid.
pub fn validate(baseline: &Baseline, file_exists: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut problems = Vec::new();
    if baseline.version != 1 {
        problems.push(format!("unknown baseline version {}", baseline.version));
    }
    let mut seen = BTreeSet::new();
    for entry in &baseline.entries {
        let key = Key {
            file: entry.file.clone(),
            test: entry.test.clone(),
        };
        if entry.test.trim().is_empty() {
            problems.push(format!("`{key}`: no test"));
        }
        if entry.reason.trim().is_empty() {
            problems.push(format!("`{key}`: no reason"));
        }
        let needed = match entry.kind {
            Kind::Fails => 1,
            Kind::Flaky => 2,
        };
        let urls = entry
            .evidence
            .iter()
            .filter(|url| url.starts_with("https://"))
            .count();
        if urls != entry.evidence.len() || urls < needed {
            problems.push(format!(
                "`{key}`: evidence must be {needed} or more https run URLs{}",
                if entry.kind == Kind::Flaky {
                    " (a failing run and a passing run)"
                } else {
                    ""
                }
            ));
        }
        if !file_exists(&entry.file) {
            problems.push(format!("`{key}`: `{}` does not exist", entry.file));
        }
        if !seen.insert(key.clone()) {
            problems.push(format!("`{key}`: listed twice"));
        }
    }
    problems
}

/// The baseline against the reports' outcomes, merged across workspaces.
pub fn compare(outcomes: &Outcomes, baseline: &Baseline) -> Verdict {
    let mut verdict = Verdict::default();
    let entries: BTreeMap<Key, Kind> = baseline
        .entries
        .iter()
        .map(|e| {
            (
                Key {
                    file: e.file.clone(),
                    test: e.test.clone(),
                },
                e.kind,
            )
        })
        .collect();
    for key in &outcomes.failed {
        if !entries.contains_key(key) {
            verdict
                .errors
                .push(format!("new failure, not in the baseline: {key}"));
        }
    }
    for (key, kind) in &entries {
        let failed = outcomes.failed.contains(key);
        let passed = outcomes.passed.contains(key);
        match (kind, failed, passed) {
            (_, false, false) => verdict.errors.push(format!(
                "baseline entry not in the reports (renamed, removed or skipped): {key}"
            )),
            (Kind::Fails, false, true) => verdict.errors.push(format!(
                "baseline entry now passes; remove it from the baseline: {key}"
            )),
            (Kind::Flaky, false, true) => verdict
                .notices
                .push(format!("flaky baseline entry passed this run: {key}")),
            _ => {}
        }
    }
    verdict
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Reads every workspace's reports from `reports` and the baseline, and returns the verdict.
pub fn check_reports(root: &Path, reports: &Path, baseline_path: &Path) -> Result<Verdict> {
    let workspaces = parse_workspaces(
        &fs::read_to_string(root.join("package.json")).context("cannot read package.json")?,
    )?;
    let raw = fs::read_to_string(baseline_path)
        .with_context(|| format!("cannot read `{}`", baseline_path.display()))?;
    let baseline: Baseline = serde_json::from_str(&raw)
        .with_context(|| format!("`{}` is not a valid baseline", baseline_path.display()))?;
    let mut verdict = Verdict {
        errors: validate(&baseline, &|file| root.join(file).exists()),
        notices: Vec::new(),
    };
    let root_str = root.to_string_lossy();
    let mut all = Outcomes::default();
    for workspace in &workspaces {
        let name = workspace.rsplit('/').next().unwrap_or(workspace);
        let read = |suffix: &str| fs::read_to_string(reports.join(format!("{name}{suffix}")));
        let (Ok(report), Ok(unhandled), Ok(exit)) =
            (read(".json"), read(".unhandled.json"), read(".exit"))
        else {
            verdict.errors.push(format!(
                "{workspace}: a report is missing ({name}.json, {name}.unhandled.json, {name}.exit)"
            ));
            continue;
        };
        let outcomes = match workspace_outcomes(&root_str, workspace, &report, &unhandled) {
            Ok(outcomes) => outcomes,
            Err(err) => {
                verdict
                    .errors
                    .push(format!("{workspace}: report unreadable: {err:#}"));
                continue;
            }
        };
        let code: i32 = match exit.trim().parse() {
            Ok(code) => code,
            Err(_) => {
                verdict.errors.push(format!(
                    "{workspace}: exit code `{}` is not a number",
                    exit.trim()
                ));
                continue;
            }
        };
        if code != 0 && outcomes.failed.is_empty() {
            verdict.errors.push(format!(
                "{workspace}: the suite exited {code} with no failed test, file or unhandled error recorded"
            ));
        }
        all.failed.extend(outcomes.failed);
        all.passed.extend(outcomes.passed);
    }
    let failed = all.failed.clone();
    all.passed.retain(|key| !failed.contains(key));
    let compared = compare(&all, &baseline);
    verdict.errors.extend(compared.errors);
    verdict.notices.extend(compared.notices);
    Ok(verdict)
}

pub fn run(root: &Path, args: &[String]) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("workspaces") => {
            let raw =
                fs::read_to_string(root.join("package.json")).context("cannot read package.json")?;
            for workspace in parse_workspaces(&raw)? {
                println!("{workspace}");
            }
            Ok(())
        }
        Some("check") => {
            let reports = flag(args, "--reports").context("`check` requires `--reports <dir>`")?;
            let baseline = flag(args, "--baseline")
                .map_or_else(|| root.join(DEFAULT_BASELINE), |p| root.join(p));
            let verdict = check_reports(root, Path::new(&reports), &baseline)?;
            for notice in &verdict.notices {
                println!("::notice title=full-suite baseline::{notice}");
            }
            for error in &verdict.errors {
                println!("::error title=full-suite baseline::{error}");
            }
            if !verdict.errors.is_empty() {
                bail!(
                    "suite-baseline: {} problem(s); see the lines above",
                    verdict.errors.len()
                );
            }
            println!(
                "  suite-baseline PASS: every failure is in the baseline, and every `fails` entry still fails ({} notice(s))",
                verdict.notices.len()
            );
            Ok(())
        }
        _ => bail!("usage: cargo xtask suite-baseline workspaces | check --reports <dir> [--baseline <file>]"),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const ROOT: &str = "/repo";

    /// A test: its describe titles, title and status.
    type TestRow<'a> = (&'a [&'a str], &'a str, &'a str);
    /// A file: its repository-relative path, status and tests.
    type FileRow<'a> = (&'a str, &'a str, &'a [TestRow<'a>]);

    fn report(files: &[FileRow<'_>]) -> String {
        let results: Vec<serde_json::Value> = files
            .iter()
            .map(|(file, status, tests)| {
                serde_json::json!({
                    "name": format!("{ROOT}/{file}"),
                    "status": status,
                    "message": "",
                    "assertionResults": tests.iter().map(|(ancestors, title, status)| serde_json::json!({
                        "ancestorTitles": ancestors, "title": title, "fullName": title, "status": status,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        serde_json::json!({ "success": false, "testResults": results }).to_string()
    }

    fn entry(file: &str, test: &str, kind: Kind) -> Entry {
        Entry {
            file: file.into(),
            test: test.into(),
            kind,
            reason: "no tty on the runner".into(),
            evidence: vec![
                "https://github.com/o/r/actions/runs/1".into(),
                "https://github.com/o/r/actions/runs/2".into(),
            ],
        }
    }

    fn baseline(entries: Vec<Entry>) -> Baseline {
        Baseline {
            version: 1,
            entries,
        }
    }

    const A: &str = "packages/daemon/test/a.test.ts";
    const B: &str = "packages/daemon/test/b.test.ts";

    /// a.test.ts: `group > passes` passes and `group > fails` fails; b.test.ts fails to import.
    fn outcomes(unhandled: usize) -> Outcomes {
        let r = report(&[
            (
                A,
                "failed",
                &[
                    (&["group"], "passes", "passed"),
                    (&["group"], "fails", "failed"),
                    (&["group"], "skipped", "skipped"),
                ],
            ),
            (B, "failed", &[]),
        ]);
        workspace_outcomes(
            ROOT,
            "packages/daemon",
            &r,
            &format!("{{\"count\":{unhandled}}}"),
        )
        .unwrap()
    }

    fn key(file: &str, test: &str) -> Key {
        Key {
            file: file.into(),
            test: test.into(),
        }
    }

    #[test]
    fn suite_baseline_workspaces_come_from_test_workspaces() {
        let pj = r#"{"scripts":{"test:workspaces":"npm run test -w packages/daemon -w packages/cli --workspace=packages/tui"}}"#;
        assert_eq!(
            parse_workspaces(pj).unwrap(),
            ["packages/daemon", "packages/cli", "packages/tui"]
        );
        assert!(parse_workspaces(r#"{"scripts":{}}"#).is_err());
        assert!(parse_workspaces(r#"{"scripts":{"test:workspaces":"vitest run"}}"#).is_err());
    }

    #[test]
    fn suite_baseline_keys_tests_files_and_unhandled_errors() {
        let o = outcomes(1);
        assert!(o.failed.contains(&key(A, "group > fails")));
        assert!(o.passed.contains(&key(A, "group > passes")));
        assert!(!o.passed.contains(&key(A, "group > skipped")));
        assert!(
            !o.failed.contains(&key(A, FILE_TEST)),
            "a.test.ts failed through a test"
        );
        assert!(
            o.failed.contains(&key(B, FILE_TEST)),
            "b.test.ts failed with no test"
        );
        assert!(o.failed.contains(&key("packages/daemon", UNHANDLED_TEST)));
        assert!(outcomes(0)
            .passed
            .contains(&key("packages/daemon", UNHANDLED_TEST)));
    }

    #[test]
    fn suite_baseline_a_report_outside_the_root_is_unreadable() {
        let r = report(&[(A, "passed", &[])]);
        assert!(workspace_outcomes("/elsewhere", "packages/daemon", &r, r#"{"count":0}"#).is_err());
        assert!(workspace_outcomes(ROOT, "packages/daemon", "not json", r#"{"count":0}"#).is_err());
    }

    #[test]
    fn suite_baseline_a_new_failure_fails() {
        let v = compare(
            &outcomes(0),
            &baseline(vec![entry(A, "group > fails", Kind::Fails)]),
        );
        assert_eq!(v.errors.len(), 1, "{v:?}");
        assert!(v.errors[0].contains("new failure") && v.errors[0].contains(B));
    }

    #[test]
    fn suite_baseline_every_failure_baselined_passes() {
        let v = compare(
            &outcomes(1),
            &baseline(vec![
                entry(A, "group > fails", Kind::Fails),
                entry(B, FILE_TEST, Kind::Fails),
                entry("packages/daemon", UNHANDLED_TEST, Kind::Flaky),
            ]),
        );
        assert_eq!(v, Verdict::default());
    }

    /// The rot rule: a `fails` entry whose test passes fails the job.
    #[test]
    fn suite_baseline_a_fails_entry_that_passes_fails() {
        let v = compare(
            &outcomes(0),
            &baseline(vec![
                entry(A, "group > fails", Kind::Fails),
                entry(B, FILE_TEST, Kind::Fails),
                entry(A, "group > passes", Kind::Fails),
            ]),
        );
        assert_eq!(v.errors.len(), 1, "{v:?}");
        assert!(v.errors[0].contains("now passes") && v.errors[0].contains("group > passes"));
    }

    #[test]
    fn suite_baseline_a_flaky_entry_that_passes_is_a_notice() {
        let v = compare(
            &outcomes(0),
            &baseline(vec![
                entry(A, "group > fails", Kind::Fails),
                entry(B, FILE_TEST, Kind::Fails),
                entry(A, "group > passes", Kind::Flaky),
            ]),
        );
        assert!(v.errors.is_empty(), "{v:?}");
        assert_eq!(v.notices.len(), 1);
    }

    #[test]
    fn suite_baseline_an_entry_absent_from_the_reports_fails_whatever_its_kind() {
        for kind in [Kind::Fails, Kind::Flaky] {
            let v = compare(
                &outcomes(0),
                &baseline(vec![
                    entry(A, "group > fails", Kind::Fails),
                    entry(B, FILE_TEST, Kind::Fails),
                    entry(A, "group > renamed", kind),
                    entry(A, "group > skipped", kind),
                ]),
            );
            assert_eq!(v.errors.len(), 2, "{kind:?}: {v:?}");
            assert!(v.errors.iter().all(|e| e.contains("not in the reports")));
        }
    }

    #[test]
    fn suite_baseline_invalid_entries_are_refused() {
        let exists = |f: &str| f != "packages/daemon/test/gone.test.ts";
        let mut no_reason = entry(A, "x", Kind::Fails);
        no_reason.reason = " ".into();
        let mut not_https = entry(A, "y", Kind::Fails);
        not_https.evidence = vec!["http://example.com/run".into()];
        let mut one_flaky_url = entry(A, "z", Kind::Flaky);
        one_flaky_url.evidence.truncate(1);
        let problems = validate(
            &baseline(vec![
                no_reason,
                not_https,
                one_flaky_url,
                entry("packages/daemon/test/gone.test.ts", "w", Kind::Fails),
                entry(A, "dup", Kind::Fails),
                entry(A, "dup", Kind::Flaky),
            ]),
            &exists,
        );
        assert_eq!(problems.len(), 5, "{problems:#?}");
        assert!(validate(&baseline(vec![entry(A, "ok", Kind::Flaky)]), &exists).is_empty());
        let unknown = r#"{"version":1,"entries":[{"file":"a","test":"b","kind":"fails","reason":"r","evidence":[],"extra":1}]}"#;
        assert!(serde_json::from_str::<Baseline>(unknown).is_err());
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "xtask-suite-baseline-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("reports")).unwrap();
        fs::create_dir_all(dir.join("packages/daemon/test")).unwrap();
        fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"test:workspaces":"npm run test -w packages/daemon"}}"#,
        )
        .unwrap();
        fs::write(dir.join("baseline.json"), r#"{"version":1,"entries":[]}"#).unwrap();
        dir
    }

    #[test]
    fn suite_baseline_a_missing_report_or_an_unexplained_exit_fails() {
        let dir = scratch("reports");
        let root = dir.to_string_lossy().to_string();
        let v = check_reports(&dir, &dir.join("reports"), &dir.join("baseline.json")).unwrap();
        assert_eq!(v.errors.len(), 1, "{v:?}");
        assert!(v.errors[0].contains("missing"));

        let passing = serde_json::json!({ "testResults": [{
            "name": format!("{root}/{A}"), "status": "passed",
            "assertionResults": [{ "ancestorTitles": [], "title": "t", "status": "passed" }],
        }]})
        .to_string();
        fs::write(dir.join("reports/daemon.json"), &passing).unwrap();
        fs::write(dir.join("reports/daemon.unhandled.json"), r#"{"count":0}"#).unwrap();
        fs::write(dir.join("reports/daemon.exit"), "0\n").unwrap();
        let v = check_reports(&dir, &dir.join("reports"), &dir.join("baseline.json")).unwrap();
        assert_eq!(v, Verdict::default());

        fs::write(dir.join("reports/daemon.exit"), "1\n").unwrap();
        let v = check_reports(&dir, &dir.join("reports"), &dir.join("baseline.json")).unwrap();
        assert_eq!(v.errors.len(), 1, "{v:?}");
        assert!(v.errors[0].contains("exited 1"));
        let _ = fs::remove_dir_all(&dir);
    }
}
