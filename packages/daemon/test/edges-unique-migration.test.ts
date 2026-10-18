// CER-3002 (spec 0008): the edges table holds at most one row per (rig, source, target, kind). addEdge collapses a
// duplicate; migration 900_edges_unique removes existing duplicates (keeping the earliest, one rig.edge_removed event per
// removed row) and adds a unique index; a binary without 900 (cw.4.3) still migrates a database where it ran.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const M900 = "900_edges_unique.sql";

describe("edges: at most one row per (rig, source, target, kind) (CER-3002)", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  const seed = () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
    for (const [id, logical] of [["n-a", "orch.lead"], ["n-b", "dev.impl"], ["n-c", "dev.qa"]]) {
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'r-1', ?)").run(id, logical);
    }
  };
  const insert = (db0: Database.Database) => (id: string, from: string, to: string, kind: string) =>
    db0.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, 'r-1', ?, ?, ?)").run(id, from, to, kind);
  const removedEvents = () => (db.prepare("SELECT rig_id, payload FROM events WHERE type = 'rig.edge_removed' ORDER BY seq").all() as
    Array<{ rig_id: string; payload: string }>).map((row) => ({ eventRigId: row.rig_id, ...JSON.parse(row.payload) as Record<string, unknown> }));

  it("addEdge returns the stored edge for an identical one and writes no row", () => {
    migrate(db, ALL_MIGRATIONS);
    seed();
    const repo = new RigRepository(db);
    const first = repo.addEdge("r-1", "n-a", "n-b", "delegates_to");
    const again = repo.addEdge("r-1", "n-a", "n-b", "delegates_to");
    expect(again.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS c FROM edges").get()).toEqual({ c: 1 });
    // a different kind, or the reverse direction, is a different edge
    repo.addEdge("r-1", "n-a", "n-b", "can_observe");
    repo.addEdge("r-1", "n-b", "n-a", "delegates_to");
    expect(db.prepare("SELECT COUNT(*) AS c FROM edges").get()).toEqual({ c: 3 });
  });

  it("migration 900 keeps the earliest row of each duplicate group, records each removed row, then refuses duplicates", () => {
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== M900));
    seed();
    const add = insert(db);
    add("e-1", "n-a", "n-b", "delegates_to"); // kept: earliest of three
    add("e-2", "n-a", "n-b", "delegates_to");
    add("e-3", "n-a", "n-b", "delegates_to");
    add("e-4", "n-b", "n-c", "can_observe");  // kept: earliest of two
    add("e-5", "n-b", "n-c", "can_observe");
    add("e-6", "n-a", "n-c", "delegates_to"); // unique, untouched

    migrate(db, ALL_MIGRATIONS);

    expect(db.prepare("SELECT id FROM edges ORDER BY id").all()).toEqual([{ id: "e-1" }, { id: "e-4" }, { id: "e-6" }]);
    const by = { session: "migration 900_edges_unique", provenance: "migration" };
    expect(removedEvents()).toEqual([
      { eventRigId: "r-1", type: "rig.edge_removed", rigId: "r-1", edgeId: "e-2", from: "orch.lead", to: "dev.impl", kind: "delegates_to", by },
      { eventRigId: "r-1", type: "rig.edge_removed", rigId: "r-1", edgeId: "e-3", from: "orch.lead", to: "dev.impl", kind: "delegates_to", by },
      { eventRigId: "r-1", type: "rig.edge_removed", rigId: "r-1", edgeId: "e-5", from: "dev.impl", to: "dev.qa", kind: "can_observe", by },
    ]);
    expect(() => add("e-7", "n-a", "n-b", "delegates_to")).toThrow(/UNIQUE/);
  });

  it("a binary without 900 (a cw.4.3 rollback) still migrates a database where 900 ran, and the index stays", () => {
    migrate(db, ALL_MIGRATIONS);
    seed();
    expect(() => migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== M900))).not.toThrow();
    expect((db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(M900) as { name: string } | undefined)?.name).toBe(M900);
    const add = insert(db);
    add("e-1", "n-a", "n-b", "delegates_to");
    expect(() => add("e-2", "n-a", "n-b", "delegates_to")).toThrow(/UNIQUE/);
  });
});
