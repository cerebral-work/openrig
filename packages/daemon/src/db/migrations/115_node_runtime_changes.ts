import type { Migration } from "../migrate.js";

// Spec 0005 (cerebral-work fork): a seat's runtime can change through a recorded handover.
// - occupant_tenures.runtime: the runtime each occupant generation ran, backfilled from its node.
// - node_runtime_changes: the append-only ledger of runtime changes and reverts, committed or failed. It names the
//   member env and hashes each value, never storing a raw value. spec_sha256 is the sha256 of the spec text the daemon
//   parsed and validated, which the CLI reads from spec_path; the daemon does not read spec_path itself.
// - node_runtime_revert_slots: one per node, the state a revert of its last committed change restores (node fields,
//   member env, permission selection and startup context before that change). Operational state, like nodes.env_json.
// Numbered 115: upstream main already has 114. The fork keeps its migration numbers clear of upstream's at each sync.
export const nodeRuntimeChangesSchema: Migration = {
  name: "115_node_runtime_changes.sql",
  sql: `
    ALTER TABLE occupant_tenures ADD COLUMN runtime TEXT;
    UPDATE occupant_tenures SET runtime = (SELECT n.runtime FROM nodes n WHERE n.id = occupant_tenures.node_id);
    CREATE TABLE node_runtime_changes (
      id                TEXT PRIMARY KEY,
      node_id           TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind              TEXT NOT NULL CHECK (kind IN ('change', 'revert')),
      reverts_change_id TEXT,
      outcome           TEXT NOT NULL CHECK (outcome IN ('committed', 'failed')),
      failure           TEXT,
      generation_uuid   TEXT,
      from_runtime      TEXT,
      to_runtime        TEXT NOT NULL,
      from_model        TEXT,
      to_model          TEXT,
      from_cwd          TEXT,
      to_cwd            TEXT,
      from_effort       TEXT,
      to_effort         TEXT,
      from_permission   TEXT,
      to_permission     TEXT,
      from_env          TEXT,
      to_env            TEXT,
      spec_path         TEXT,
      spec_sha256       TEXT,
      approval          TEXT NOT NULL,
      reason            TEXT NOT NULL,
      operator          TEXT NOT NULL,
      acceptance        TEXT,
      created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX idx_node_runtime_changes_node ON node_runtime_changes(node_id, created_at);
    CREATE TABLE node_runtime_revert_slots (
      node_id     TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      change_id   TEXT NOT NULL REFERENCES node_runtime_changes(id) ON DELETE CASCADE,
      before_json TEXT NOT NULL
    );
  `,
};
