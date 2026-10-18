// Migration 116 on an install that already holds runtime changes: committed rows are backfilled as declared (the
// daemon restart that applies the migration empties the in-memory activity ladder, so nothing undeclared can remain);
// failed rows stay without a marker.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { NodeRuntimeChangeLedger } from "../src/domain/node-runtime-changes.js";

describe("migration 116 (runtime change declared) on an install that already holds runtime changes", () => {
  let db: Database.Database;
  beforeEach(() => { db = createDb(); });
  afterEach(() => { db.close(); });

  it("backfills committed rows as declared before 116 and leaves failed rows unmarked", () => {
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "116_node_runtime_change_declared.sql"));
    const applied = () => (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((r) => r.name);
    expect(applied()).toContain("115_node_runtime_changes.sql");
    expect(applied()).not.toContain("116_node_runtime_change_declared.sql");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-1', 'r-1', 'dev.impl')").run();
    const insert = db.prepare(`INSERT INTO node_runtime_changes (id, node_id, kind, outcome, failure, to_runtime, approval, reason, operator, created_at)
      VALUES (?, 'n-1', 'change', ?, ?, 'claude-code', 'go', 'r', 'operator-agent@kernel', ?)`);
    insert.run("c-1", "committed", null, "2026-10-18T10:00:00.000Z");
    insert.run("c-2", "failed", "successor_create_failed at create-successor:resolve_pane:pane_unresolved", "2026-10-18T10:05:00.000Z");

    migrate(db, ALL_MIGRATIONS);
    expect(applied()).toContain("116_node_runtime_change_declared.sql");
    expect(db.prepare("SELECT id, declared_at, declared_by FROM node_runtime_changes ORDER BY id").all()).toEqual([
      { id: "c-1", declared_at: "2026-10-18T10:00:00.000Z", declared_by: "before-116" },
      { id: "c-2", declared_at: null, declared_by: null },
    ]);
  });

  it("a database from before the runtime-change ledger (an older fixture) has no pending declarations, and never throws", () => {
    migrate(db, ALL_MIGRATIONS.filter((m) => !/^11[56]_/.test(m.name)));
    expect(new NodeRuntimeChangeLedger(db).pendingDeclarations()).toEqual(new Map());
  });
});
