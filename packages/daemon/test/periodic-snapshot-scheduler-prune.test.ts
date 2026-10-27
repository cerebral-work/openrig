// CER-3089 — telemetry retention run by the periodic snapshot scheduler's tick.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { PeriodicSnapshotScheduler } from "../src/domain/periodic-snapshot-scheduler.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { createFullTestDb } from "./helpers/test-app.js";

const isoStamp = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

describe("PeriodicSnapshotScheduler telemetry retention", () => {
  let db: Database.Database;
  let scheduler: PeriodicSnapshotScheduler;

  beforeEach(() => {
    db = createFullTestDb();
    // The shared fixture omits both telemetry tables (see migrationsForFullTestDbExclusions).
    db.exec(usageSamplesSchema.sql);
    db.exec(watchdogHistorySchema.sql);
    scheduler = new PeriodicSnapshotScheduler({
      db,
      snapshotCapture: {} as SnapshotCapture,
      snapshotRepo: {} as SnapshotRepository,
    });
  });

  afterEach(() => {
    db.close();
  });

  // SQLite's own timestamp form (datetime('now', ...)) has a space and no zone; the daemon's ISO form has a T and a Z.
  // As text, "YYYY-MM-DD HH:MM:SS" sorts below "YYYY-MM-DDTHH:MM:SS" on the same date, whatever the time of day.
  const sqliteStamp = (...modifiers: [string, string?]): string =>
    (db.prepare(`SELECT datetime('now', ?, ?) AS t`).get(modifiers[0], modifiers[1] ?? "+0 seconds") as { t: string }).t;

  const addUsage = (id: number, capturedAt: string) =>
    db.prepare(`INSERT INTO usage_samples (id, lane, seat_session, captured_at) VALUES (?, 'context', 'seat@rig', ?)`).run(id, capturedAt);
  const usageIds = () => (db.prepare(`SELECT id FROM usage_samples ORDER BY id`).all() as { id: number }[]).map((r) => r.id);

  const addJob = () =>
    db.prepare(`INSERT INTO watchdog_jobs (job_id, policy, spec_yaml, target_session, interval_seconds, registered_by_session, registered_at)
                VALUES ('job-1', 'p', 'y', 't@rig', 60, 'r@rig', '2026-01-01T00:00:00Z')`).run();
  const addHistory = (id: string, evaluatedAt: string) =>
    db.prepare(`INSERT INTO watchdog_history (history_id, job_id, evaluated_at, outcome) VALUES (?, 'job-1', ?, 'skip')`).run(id, evaluatedAt);
  const historyIds = () => (db.prepare(`SELECT history_id FROM watchdog_history ORDER BY history_id`).all() as { history_id: string }[]).map((r) => r.history_id);

  it("usage_samples: a SQLite-form captured_at is aged by instant, not by text", async () => {
    addUsage(1, sqliteStamp("-8 days"));
    // One minute inside the window, on the cut's own date: its text sorts below the ISO cut and was deleted.
    addUsage(2, sqliteStamp("-7 days", "+1 minute"));
    addUsage(3, sqliteStamp("-1 days"));
    addUsage(4, isoStamp(0));
    await scheduler.tick();
    expect(usageIds()).toEqual([2, 3, 4]);
  });

  it("usage_samples: an ISO row older than 7 days goes, a fresh one stays", async () => {
    addUsage(1, isoStamp(-7.5));
    addUsage(2, isoStamp(-6.5));
    addUsage(3, isoStamp(0));
    await scheduler.tick();
    expect(usageIds()).toEqual([2, 3]);
  });

  it("watchdog_history: a SQLite-form evaluated_at is aged by instant, not by text", async () => {
    addJob();
    addHistory("old-sqlite", sqliteStamp("-8 days"));
    addHistory("fresh-sqlite", sqliteStamp("-7 days", "+1 minute"));
    addHistory("fresh-iso", isoStamp(0));
    addHistory("old-iso", isoStamp(-9));
    await scheduler.tick();
    expect(historyIds()).toEqual(["fresh-iso", "fresh-sqlite"]);
  });

  it("snapshots: rows of a deleted rig go, rows of a live rig stay", async () => {
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-live', 'live')`).run();
    const insert = db.prepare(`INSERT INTO snapshots (id, rig_id, kind, status, data) VALUES (?, ?, 'manual', 'complete', '{}')`);
    insert.run("snap-live", "rig-live");
    insert.run("snap-orphan", "rig-gone");
    await scheduler.tick();
    const ids = (db.prepare(`SELECT id FROM snapshots ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(["snap-live"]);
  });

});
