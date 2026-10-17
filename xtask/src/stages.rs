// Lowered from `projectfile.yaml` `org.projectfile.ci.nodes`.
// `cargo xtask stages-check` fails if this table and the projectfile diverge.

/// Default concurrent job limit on shared hosts (`ceres`).
pub const DEFAULT_JOBS: usize = 2;

/// Leaf gates in topological order, lowered from the CI DAG.
pub const XWORK_STAGES: &[(&str, &[&str])] = &[
    ("projectfile-check", &[]),
    ("stages-check", &[]),
    ("spec-check", &[]),
    ("branch-hygiene", &[]),
    ("cargo-fmt", &[]),
    ("cargo-clippy", &[]),
    ("cargo-test", &[]),
    ("npm-lint", &["run", "lint"]),
    ("npm-test-repo", &["run", "test:repo"]),
    ("npm-test-workspaces", &["run", "test:workspaces"]),
    ("npm-build-package", &["run", "build:package"]),
];

/// Fast zero-compile governance gates (`cargo xtask hygiene`).
pub const HYGIENE_STAGES: &[&str] = &[
    "projectfile-check",
    "stages-check",
    "spec-check",
    "branch-hygiene",
];
