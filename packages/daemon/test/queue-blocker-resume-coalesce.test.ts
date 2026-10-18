// Queue churn C (cerebral-work fork): blocker-resolved notices coalesce per owner ACROSS blockers within a
// window. The first notice goes at once; later ones in the window are held pending and flushed together at the
// window's end, in one message that names every held blocker and parked row. Nothing is dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";

describe("churn C — blocker-resolved notices coalesce per owner across blockers", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let sent: Array<{ session: string; text: string }>;
  let transportResult: Awaited<ReturnType<QueueNudgeTransport["send"]>>;
  let offsetMs: number;
  let flushes: Array<{ run: () => void; delayMs: number }>;

  function build(windowMinutes = 10): void {
    repo = new QueueRepository(db, new EventBus(db), {
      now: () => new Date(Date.now() + offsetMs),
      scheduleCoalesceFlush: (run, delayMs) => void flushes.push({ run, delayMs }),
      blockerResumeCoalesceMinutes: () => windowMinutes,
    });
    repo.attachOutbox(new OutboxHandler(db));
    repo.attachTransport({ async send(session, text) { sent.push({ session, text }); return transportResult; } });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema,
      watchdogJobsSchema, watchdogHistorySchema, queueItemSummarySchema, queueItemEvidenceRefSchema, queueTransitionWakesSchema]);
    sent = [];
    transportResult = { ok: true, verified: true };
    offsetMs = 0;
    flushes = [];
    build();
  });
  afterEach(() => db.close());

  const item = (destinationSession: string) =>
    repo.create({ sourceSession: "orch@rig", destinationSession, body: "work", nudge: false });

  /** A row of worker@rig parked on its own blocker; returns both ids. */
  async function parked(): Promise<{ row: string; blocker: string }> {
    const blocker = await item("gate@rig");
    const row = await item("worker@rig");
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: blocker.qitemId,
      transitionNote: "continuation: resume after the gate" });
    return { row: row.qitemId, blocker: blocker.qitemId };
  }
  function resolve(blocker: string): void {
    repo.update({ qitemId: blocker, actorSession: "gate@rig", state: "done", closureReason: "no-follow-on", transitionNote: "gate cleared" });
  }
  const toWorker = () => sent.filter((call) => call.session === "worker@rig");

  it("a second blocker resolving inside the window is held, not sent", async () => {
    const a = await parked();
    const b = await parked();
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    offsetMs = 60_000;
    resolve(b.blocker);
    await new Promise((r) => setTimeout(r, 20));
    expect(toWorker()).toHaveLength(1);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.delayMs).toBeGreaterThan(8 * 60_000);
    expect(flushes[0]!.delayMs).toBeLessThanOrEqual(9 * 60_000);
  });

  it("the held notices are sent at the window's end in one message naming every held blocker and parked row", async () => {
    const a = await parked();
    const b = await parked();
    const c = await parked();
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    offsetMs = 60_000;
    resolve(b.blocker);
    offsetMs = 120_000;
    resolve(c.blocker);
    await new Promise((r) => setTimeout(r, 20));
    expect(toWorker()).toHaveLength(1);
    offsetMs = 10 * 60_000 + 1_000;
    flushes[0]!.run();
    await vi.waitFor(() => expect(toWorker()).toHaveLength(2));
    const flushed = toWorker()[1]!.text;
    for (const id of [b.blocker, b.row, c.blocker, c.row]) expect(flushed).toContain(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(toWorker()).toHaveLength(2);
  });

  it("a notice after the window is sent at once", async () => {
    const a = await parked();
    const b = await parked();
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    offsetMs = 11 * 60_000;
    resolve(b.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(2));
    expect(flushes).toHaveLength(0);
  });

  it("a failed notice does not open a window", async () => {
    const a = await parked();
    const b = await parked();
    transportResult = { ok: false, error: "owner unreachable" };
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    transportResult = { ok: true, verified: true };
    offsetMs = 60_000;
    resolve(b.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(2));
  });

  it("the window is the configured value, not a constant", async () => {
    build(1);
    const a = await parked();
    const b = await parked();
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    offsetMs = 2 * 60_000;
    resolve(b.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(2));
  });

  it("a held notice is still pending, so the startup drain delivers it after the window", async () => {
    const a = await parked();
    const b = await parked();
    resolve(a.blocker);
    await vi.waitFor(() => expect(toWorker()).toHaveLength(1));
    offsetMs = 60_000;
    resolve(b.blocker);
    await new Promise((r) => setTimeout(r, 20));
    offsetMs = 10 * 60_000 + 1_000;
    await repo.drainPendingWakeIntents();
    expect(toWorker()).toHaveLength(2);
    expect(toWorker()[1]!.text).toContain(b.row);
  });
});
