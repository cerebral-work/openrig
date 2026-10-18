import type { Migration } from "../migrate.js";

// Spec 0005 (cerebral-work fork): post-commit recovery. A committed runtime change records whether its occupant swap
// was declared to the activity oracle. declared_at and declared_by are set once: by the commit after the declaration
// succeeds (by the change's operator), or by `rig seat runtime-declare` (by its caller). NULL on a committed row means
// the declaration is pending: the oracle failed after the commit landed (handover_committed_swap_undeclared). Failed
// rows never carry them. Committed rows from before this migration are backfilled as declared by "before-116": the
// daemon restart that applies this migration empties the in-memory activity ladder, so no undeclared swap can remain.
// Numbered 116 after the fork's 115, clear of upstream's numbers; renumber at the next upstream sync if needed.
export const nodeRuntimeChangeDeclaredSchema: Migration = {
  name: "116_node_runtime_change_declared.sql",
  sql: `
    ALTER TABLE node_runtime_changes ADD COLUMN declared_at TEXT;
    ALTER TABLE node_runtime_changes ADD COLUMN declared_by TEXT;
    UPDATE node_runtime_changes SET declared_at = created_at, declared_by = 'before-116' WHERE outcome = 'committed';
  `,
};
