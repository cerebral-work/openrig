import type { Migration } from "../migrate.js";

// CER-3002 (spec 0008): the edges table holds at most one row per (rig, source, target, kind). Before this, nothing
// prevented a duplicate: an expand fragment, a `rig add` member or a rig spec that listed an edge twice stored it twice.
// Every duplicate row except the earliest of its group (lowest rowid, i.e. insertion order) is recorded as a
// rig.edge_removed event, shaped as `rig edge remove` writes it, with the migration as `by`, then deleted; the unique
// index then refuses any new duplicate. migrate.ts runs this in one transaction.
//
// Numbered 900: fork-only migrations take 900-999 from CER-3002 on, so they never collide with upstream's sequence
// (upstream was at 114 on 2026-10-18 and continues at 115 and up). The fork's 115 and 116 keep their numbers, because
// databases record applied migrations by name. An upstream migration that rebuilds `edges` would drop this index:
// check at each upstream sync.
export const edgesUniqueSchema: Migration = {
  name: "900_edges_unique.sql",
  sql: `
    INSERT INTO events (rig_id, node_id, type, payload)
    SELECT e.rig_id, NULL, 'rig.edge_removed', json_object(
      'type', 'rig.edge_removed', 'rigId', e.rig_id, 'edgeId', e.id, 'from', s.logical_id, 'to', t.logical_id, 'kind', e.kind,
      'by', json_object('session', 'migration 900_edges_unique', 'provenance', 'migration'))
    FROM edges e
    JOIN nodes s ON s.id = e.source_id
    JOIN nodes t ON t.id = e.target_id
    WHERE e.rowid NOT IN (SELECT MIN(rowid) FROM edges GROUP BY rig_id, source_id, target_id, kind)
    ORDER BY e.rowid;
    DELETE FROM edges WHERE rowid NOT IN (SELECT MIN(rowid) FROM edges GROUP BY rig_id, source_id, target_id, kind);
    CREATE UNIQUE INDEX idx_edges_unique ON edges(rig_id, source_id, target_id, kind);
  `,
};
