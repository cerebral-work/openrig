// Spec 0011: a park's blocker resolves by row lookup, not by the qitem- prefix. A custom row id gets the
// same validation, projection and wake as a qitem- row. On the CLI and agent path (strictBlocker, set by the
// update route) a park must name a live row, a typed gate or a name@host address; closures the daemon
// writes in-process keep their authored gate names. Motivating case: a park on a custom row that is
// already done could never lift.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, QueueRepositoryError, TYPED_GATE_BLOCKER_PREFIXES } from "../src/domain/queue-repository.js";
import { QueueWakeRepository } from "../src/domain/queue-wake-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { readWaitingView } from "../src/domain/queue-waiting.js";
import { verificationCommand } from "../src/domain/queue-stuck-sweep.js";
import { armQueueWait } from "../src/domain/queue-wait-backoff.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import { createTestApp } from "./helpers/test-app.js";

describe("park blockers resolve by row lookup (spec 0011)", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const row = (body = "work", qitemId?: string) =>
    repo.create({ ...(qitemId ? { qitemId } : {}), sourceSession: "lead@r", destinationSession: "dev@r", body, nudge: false });
  const park = (qitemId: string, blockedOn: string, strict: boolean) =>
    repo.update({ qitemId, actorSession: "dev@r", state: "blocked", blockedOn, strictBlocker: strict, wakeAfterSeconds: 600, transitionNote: "park" });
  const code = (fn: () => unknown): string | null => {
    try { fn(); return null; } catch (err) { return (err as QueueRepositoryError).code; }
  };

  it("a custom-id park on a live row validates, projects the blocker's owner and state, and wakes on it", async () => {
    await row("release tracker", "release-tracker-20261018");
    const parked = await row();
    repo.update({ qitemId: parked.qitemId, actorSession: "dev@r", state: "blocked", blockedOn: "release-tracker-20261018", strictBlocker: true, transitionNote: "park" });
    const view = readWaitingView(db, parked.qitemId);
    expect(view?.blocker).toEqual({ ref: "release-tracker-20261018", owner: "dev@r", state: "pending" });
    expect(new QueueWakeRepository(db).getStatus(parked.qitemId)).toMatchObject({ kind: "blocker", ref: "release-tracker-20261018" });
  });

  it("CLI path: a custom-id park on a terminal row is refused; an internal closure only warns", async () => {
    const done = await row("lanes", "done-custom-row-20261018");
    repo.update({ qitemId: done.qitemId, actorSession: "dev@r", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    const parked = await row();
    expect(code(() => park(parked.qitemId, "done-custom-row-20261018", true))).toBe("blocker_not_live");
    expect(code(() => park(parked.qitemId, "done-custom-row-20261018", false))).toBeNull();
  });

  it("CLI path: bare free text and an unknown prefix are refused with the accepted forms; internal closures keep them", async () => {
    const parked = await row();
    let message = "";
    try { park(parked.qitemId, "operator decision", true); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/names no queue row/);
    expect(message).toMatch(/fold:<what>, auth:<what>, external:<what>/);
    expect(message).toMatch(/free-text human wait uses external:<name>/);
    expect(code(() => park(parked.qitemId, "gate:time", true))).toBe("blocker_unknown_prefix");
    const internal = await row();
    expect(code(() => park(internal.qitemId, "authored-condition", false))).toBeNull();
    const internal2 = await row();
    expect(code(() => park(internal2.qitemId, "gate:time", false))).toBeNull();
  });

  it("a missing qitem- id is refused on every path, as before", async () => {
    const parked = await row();
    expect(code(() => park(parked.qitemId, "qitem-19990101000000-deadbeef", true))).toBe("blocker_not_found");
    expect(code(() => park(parked.qitemId, "qitem-19990101000000-deadbeef", false))).toBe("blocker_not_found");
  });

  it("CLI path: a missing qitem- id and a dead custom row are refused with the accepted forms, after the original text", async () => {
    const message = (fn: () => unknown): string => { try { fn(); return ""; } catch (err) { return (err as Error).message; } };
    const parked = await row();
    const missing = message(() => park(parked.qitemId, "qitem-19990101000000-deadbeef", true));
    expect(missing).toMatch(/^blocked_on names a qitem that does not exist on this daemon: .*use a typed gate such as external:<host>\/<id> with --wake-watchdog or --wake-after\. Accepted forms: /);
    const done = await row("closed", "dead-custom-row-20261018");
    repo.update({ qitemId: done.qitemId, actorSession: "dev@r", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    const dead = message(() => park(parked.qitemId, "dead-custom-row-20261018", true));
    expect(dead).toMatch(/^blocked_on names a resolved qitem: .*never self-clears\. Accepted forms: /);
    expect(dead).toContain("A free-text human wait uses external:<name>.");
  });

  it("typed gates and name@host addresses are accepted on the CLI path, as before", async () => {
    for (const blocker of ["external:operator-go", "fold:one-home", "auth:token-renewal", "lead@r", "human-owner@external"]) {
      const parked = await row();
      expect(code(() => park(parked.qitemId, blocker, true)), blocker).toBeNull();
    }
    expect([...TYPED_GATE_BLOCKER_PREFIXES]).toEqual(["fold:", "auth:", "external:"]);
  });

  it("an existing park is not rewritten: re-parking on the value a row already carries warns instead of refusing", async () => {
    const parked = await row();
    park(parked.qitemId, "gate:time", false);
    expect(code(() => park(parked.qitemId, "gate:time", true))).toBeNull();
  });

  it("the update route is the CLI path: it refuses free text, while the same park in-process is accepted", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const parked = await row();
    const res = await app.request(`/api/queue/${parked.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "dev@r" },
      body: JSON.stringify({ actorSession: "dev@r", state: "blocked", blockedOn: "operator decision", wakeAfterSeconds: 600, transitionNote: "park" }),
    });
    // Blocker refusals stay 500 on purpose (routes/queue.ts): the CLI pins their exit code 2.
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "blocker_not_found" });
  });

  it("a repeating wait on a custom-id blocker watches that row's own progress", async () => {
    await row("release tracker", "release-tracker-20261018");
    const parked = await row();
    const job = armQueueWait(db, new WatchdogJobsRepository(db), {
      qitemId: parked.qitemId, blocker: "release-tracker-20261018", initialSeconds: 60, maxSeconds: 600,
      message: "resume", owner: "dev@r", actor: "dev@r",
    });
    expect(JSON.parse(job.specYaml).context.queue_wait.blockerTransition).toEqual(expect.any(Number));
  });

  it("rig watchdog list names a park timer's row and that it fires once", async () => {
    const parked = await row();
    park(parked.qitemId, "external:operator-go", true);
    // The real app factory: server.ts's middleware sets db for every route, as the daemon does.
    const { app } = createTestApp(db, { appDeps: { watchdogJobsRepo: new WatchdogJobsRepository(db) } });
    const jobs = await (await app.request("/api/watchdog/list")).json() as Array<{ parkTimer?: unknown }>;
    expect(jobs.filter((job) => job.parkTimer)).toEqual([expect.objectContaining({ parkTimer: { oneShot: true, serves: [parked.qitemId] } })]);
  });

  it("the sweep verifies a custom-id successor row as a row", () => {
    expect(verificationCommand("release-tracker-20261018", true)).toBe("OPENRIG_URL=<registered-host> rig queue show release-tracker-20261018");
    expect(verificationCommand("next@r")).toBe("OPENRIG_URL=<registered-host> rig queue list --destination next@r");
  });
});
