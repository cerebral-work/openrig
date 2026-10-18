import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { escalationDedupTag, runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { queueRoutes } from "../src/routes/queue.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { QueueWakeRepository } from "../src/domain/queue-wake-repository.js";
import { diagnoseSeatParked } from "../src/domain/parked-query.js";

// Both SQL writers are supported by QueueRepository's generation-column detection.
describe.each(["current", "without generation stamps"])("claim park exit (%s schema)", (schema) => {
  let db: Database.Database;
  let repo: QueueRepository;
  let jobs: WatchdogJobsRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, schema === "current" ? ALL_MIGRATIONS : ALL_MIGRATIONS.filter((m) => m.name !== "063_occupant_generation_stamps.sql"));
    const bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true, resolveOccupantGeneration: () => "owned-generation" });
    jobs = new WatchdogJobsRepository(db);
    app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo); await next(); });
    app.route("/api/queue", queueRoutes());
  });
  afterEach(() => db.close());

  const claim = (id: string) => app.request(`/api/queue/${id}/claim`, {
    method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" }, body: "{}",
  });
  const create = (destinationSession = "worker@rig") => repo.create({
    sourceSession: "orch@rig", destinationSession, body: "owned work", nudge: false,
  });
  const timerFor = (id: string) => (db.prepare(
    "SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = ? AND wake_kind = 'timer' ORDER BY transition_id DESC LIMIT 1",
  ).get(id) as { wake_ref: string }).wake_ref;
  const rows = () => Object.fromEntries(["queue_items", "queue_transitions", "queue_transition_wakes", "watchdog_jobs", "events"].map((table) => [
    table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));

  // Spec 0011, review W1: a gate a claim retained, restored by a bare `--state blocked`, is a new park as far as lifting
  // goes. The form is waived (it was accepted when first parked), but a gate nothing lifts still needs a wake.
  const reblock = (id: string, extra: object = {}) => app.request(`/api/queue/${id}/update`, {
    method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
    body: JSON.stringify({ state: "blocked", ...extra }),
  });

  it("W1: a claim-restored typed gate needs a wake on a bare re-block; with one it is restored", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-gate", wakeAfterSeconds: 90 });
    expect((await claim(row.qitemId)).status).toBe(200);
    const refused = await reblock(row.qitemId);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: "blocker_wake_required", rejectedBlocker: "external:owned-gate" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "in-progress", blockedOn: null });
    const restored = await reblock(row.qitemId, { wakeAfterSeconds: 120 });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ state: "blocked", blockedOn: "external:owned-gate" });
  });

  // Spec 0011, review INFO on #21: a plain park timer fires once and goes terminal (park_timer_fired_once) while
  // the row stays blocked. A re-park that keeps the blocker then has nothing to lift it unless it carries a wake.
  const fireParkTimer = async (id: string) => {
    const engine = new WatchdogPolicyEngine({
      jobsRepo: jobs, historyLog: new WatchdogHistoryLog(db), eventBus: new EventBus(db),
      deliver: async () => ({ status: "ok" }),
      resolvePreDeliveryTerminalReason: ({ jobId }: { jobId: string }) => repo.resolveWatchdogPreDeliveryTerminalReason(jobId),
      onWakeAttempt: ({ jobId, deliveryStatus }) => repo.recordWatchdogWakeAttempt(jobId, deliveryStatus),
    });
    await engine.evaluate(jobs.getByIdOrThrow(timerFor(id)));
  };

  it("a still-blocked row whose park timer fired needs a wake to be re-parked on its blocker; with one it is re-armed", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-gate", wakeAfterSeconds: 90 });
    await fireParkTimer(row.qitemId);
    expect(jobs.getById(timerFor(row.qitemId))).toMatchObject({ state: "terminal", terminalReason: "park_timer_fired_once" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "blocked", blockedOn: "external:owned-gate" });
    for (const named of [{}, { blockedOn: "external:owned-gate" }]) {
      const refused = await reblock(row.qitemId, named);
      expect(refused.status, JSON.stringify(named)).toBe(500);
      expect(await refused.json()).toMatchObject({ error: "blocker_wake_required", rejectedBlocker: "external:owned-gate" });
    }
    const rearmed = await reblock(row.qitemId, { wakeAfterSeconds: 120 });
    expect(rearmed.status).toBe(200);
    expect(new QueueWakeRepository(db).getStatus(row.qitemId)).toMatchObject({ kind: "timer", live: true });
  });

  it("control: a still-blocked row whose park timer is still live is re-parked on its blocker without a wake", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-gate", wakeAfterSeconds: 3600 });
    const kept = await reblock(row.qitemId);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({ state: "blocked", blockedOn: "external:owned-gate" });
  });

  it("W1: a claim-restored live row needs no wake on a bare re-block", async () => {
    const blocker = await create("gate@rig");
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect((await claim(row.qitemId)).status).toBe(200);
    const restored = await reblock(row.qitemId);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ state: "blocked", blockedOn: blocker.qitemId });
  });

  // review-r2 I2 on #32: a blocker wake is live only while its row is still the parked row's blocker. A non-strict re-park
  // that switches the blocker to a typed gate arms no wake, so the old record must not keep reading live.
  const heldHealth = (id: string) => diagnoseSeatParked({
    getSeatState: () => null,
    listOpenObligations: (session, limit) => ({ rows: repo.listOpenObligations(session, limit), limit }),
    getParkWake: (qitemId) => repo.getParkWakeStatus(qitemId),
  }, { seatNodeId: "worker-node", sessionName: "worker@rig" }).obligations.held.find((h) => h.qitemId === id);

  it("I2: a blocker wake whose row is no longer the blocker is not live; the bare re-park needs a wake", async () => {
    const blocker = await create("gate@rig");
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: blocker.qitemId });
    // Control: parked on the live row, the blocker wake is live and the held row is healthy.
    expect(repo.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "blocker", ref: blocker.qitemId, live: true });
    expect(heldHealth(row.qitemId)).toMatchObject({ healthy: true });
    // A non-strict (repository) re-park switches the blocker to a typed gate with no wake: no new wake is armed.
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:gate" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "blocked", blockedOn: "external:gate" });
    expect(repo.getById(blocker.qitemId)).toMatchObject({ state: "pending" });
    expect(repo.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "blocker", ref: blocker.qitemId, live: false });
    expect(heldHealth(row.qitemId)).toMatchObject({ healthy: false });
    const refused = await reblock(row.qitemId);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: "blocker_wake_required", rejectedBlocker: "external:gate" });
    const rearmed = await reblock(row.qitemId, { wakeAfterSeconds: 120 });
    expect(rearmed.status).toBe(200);
    expect(repo.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "timer", live: true });
  });

  // review-r2 P1 on #32 (lead ruling: keep it): an operator watchdog survives a claim and still targets the row, so a
  // claim-restored park that still has it attached has a live wake and needs no new one.
  it("P1: a claim-restored park whose operator watchdog is still attached is re-parked without a wake", async () => {
    const row = await create();
    const job = jobs.register({
      policy: "periodic-reminder",
      specYaml: ["policy: periodic-reminder", "target:", "  session: \"worker@rig\"", "message: \"operator check\"", ""].join("\n"),
      targetSession: "worker@rig", intervalSeconds: 3600, registeredBySession: "orch@rig",
    });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-gate", wakeWatchdogId: job.jobId });
    expect((await claim(row.qitemId)).status).toBe(200);
    expect(repo.getParkWakeStatus(row.qitemId)).toMatchObject({ kind: "watchdog", ref: job.jobId, live: true });
    const restored = await reblock(row.qitemId);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ state: "blocked", blockedOn: "external:owned-gate" });
  });

  // review-r2 P2 on #32 (REQ-0011-15): a typed gate parked with no wake through a non-strict path has no live wake, so
  // a bare re-park from the CLI needs one.
  it("P2: a typed-gate park made without a wake on a non-strict path needs a wake on a CLI re-park", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-gate" });
    expect(repo.getParkWakeStatus(row.qitemId)).toBeNull();
    const refused = await reblock(row.qitemId);
    expect(refused.status).toBe(500);
    expect(await refused.json()).toMatchObject({ error: "blocker_wake_required", rejectedBlocker: "external:owned-gate" });
    const rearmed = await reblock(row.qitemId, { wakeAfterSeconds: 120 });
    expect(rearmed.status).toBe(200);
  });

  it("clears a qitem blocker and returns liveness to the claimant while preserving the sibling park", async () => {
    const blocker = await create("gate@rig");
    const row = await create();
    const sibling = await create();
    for (const item of [row, sibling]) repo.update({
      qitemId: item.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: blocker.qitemId,
    });
    expect(repo.waitingView(row.qitemId)?.liveness.subject).toBe("gate@rig");
    const response = await claim(row.qitemId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(repo.list().find((item) => item.qitemId === row.qitemId)?.blockedOn).toBeNull();
    expect(repo.waitingView(row.qitemId)).toMatchObject({ blocker: null, liveness: { subject: "worker@rig" } });
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({ transitionNote: "claimed", closureTarget: blocker.qitemId });
    expect(repo.waitingView(sibling.qitemId)).toMatchObject({ blocker: { ref: blocker.qitemId }, liveness: { subject: "gate@rig" } });
    if (schema === "current") expect(db.prepare("SELECT claimed_by_generation_uuid AS generation FROM queue_items WHERE qitem_id = ?").get(row.qitemId)).toEqual({ generation: "owned-generation" });
  });

  it("clears a typed gate and retires only its generated park timer", async () => {
    const row = await create();
    const sibling = await create();
    for (const item of [row, sibling]) repo.update({
      qitemId: item.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-window", wakeAfterSeconds: 90,
    });
    const timer = timerFor(row.qitemId);
    const siblingTimer = timerFor(sibling.qitemId);
    const response = await claim(row.qitemId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(repo.waitingView(row.qitemId)).toMatchObject({ blocker: null, liveness: { subject: "worker@rig" } });
    expect(jobs.getById(timer)).toMatchObject({ state: "terminal", terminalReason: "park_ended:claimed" });
    expect(jobs.getById(siblingTimer)?.state).toBe("active");
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({ transitionNote: "claimed", closureTarget: "external:owned-window" });
    repo.unclaim(row.qitemId, "worker@rig", "owned release");
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "pending", blockedOn: null });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked" });
    expect(repo.getById(row.qitemId)?.blockedOn).toBeNull();
  });

  it("keeps a custom-note park blocker in claim history and reuses it on a human re-park", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "human-review@kernel", transitionNote: "custom continuation",
      summary: "Review requested", evidenceRef: "evidence:before" });
    await claim(row.qitemId);
    expect(repo.getById(row.qitemId)?.blockedOn).toBeNull();
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({
      transitionNote: "claimed", closureTarget: "human-review@kernel", closureReason: null,
    });
    const response = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
      body: JSON.stringify({ state: "blocked", summary: "Still awaiting review", evidenceRef: "evidence:after" }),
    });
    expect(response.status).toBe(200);
    expect(repo.getById(row.qitemId)).toMatchObject({ blockedOn: "human-review@kernel", summary: "Still awaiting review", evidenceRef: "evidence:after" });
    await claim(row.qitemId);
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:new-gate" });
    expect(repo.getById(row.qitemId)?.blockedOn).toBe("external:new-gate");
  });

  it("keeps a claim gate through ordinary note appends, without changing claim notes", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked",
      blockedOn: "human-review@kernel", summary: "Review requested", evidenceRef: "evidence:before" });
    await claim(row.qitemId);
    for (const note of ["progress evidence", "more evidence"]) {
      const response = await app.request(`/api/queue/${row.qitemId}/update`, {
        method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
        body: JSON.stringify({ transitionNote: note }),
      });
      expect(response.status).toBe(200);
      expect(repo.getById(row.qitemId)?.blockedOn).toBeNull();
    }
    const response = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
      body: JSON.stringify({ state: "blocked", summary: "Still waiting", evidenceRef: "evidence:after" }),
    });
    expect(response.status).toBe(200);
    expect(repo.getById(row.qitemId)?.blockedOn).toBe("human-review@kernel");
    expect(repo.listTransitions(row.qitemId).find((entry) => entry.transitionNote === "claimed"))
      .toMatchObject({ transitionNote: "claimed", closureTarget: "human-review@kernel", closureReason: null });
  });

  it.each([false, true])("does not resurrect a claim gate after a state write clears it (later note: %s)", async (laterNote) => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:old-gate" });
    await claim(row.qitemId);
    const update = (body: object) => app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
      body: JSON.stringify(body),
    });
    // The same-state write is distinct from a note-only history append.
    expect((await update({ state: "in-progress", transitionNote: "gate no longer needed" })).status).toBe(200);
    if (laterNote) expect((await update({ transitionNote: "later progress" })).status).toBe(200);
    const response = await update({ state: "blocked" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ blockedOn: null });
    expect(repo.getById(row.qitemId)?.blockedOn).toBeNull();
    expect(repo.listTransitions(row.qitemId).find((entry) => entry.closureTarget === "external:old-gate"))
      .toMatchObject({ transitionNote: "claimed", closureReason: null });
  });

  it.each([false, true])("preserves only an unchanged claim gate through an overdue audit (cleared: %s)", async (cleared) => {
    const row = await repo.create({ sourceSession: "orch@rig", destinationSession: "worker@rig", body: "owned overdue work", tier: "fast", nudge: false });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:old-gate" });
    await claim(row.qitemId);
    if (cleared) repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "in-progress", transitionNote: "gate no longer needed" });
    expect(repo.recordClosureOverdue(row.qitemId, { now: "9999-01-01T00:00:00.000Z" })).not.toBeNull();
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({
      state: "in-progress", actorSession: "daemon@system", transitionNote: "closure-overdue",
      closureTarget: cleared ? null : "external:old-gate", closureReason: null,
    });
    expect(repo.recordClosureOverdue(row.qitemId, { now: "9999-01-01T00:00:00.000Z" })).toBeNull();
    const response = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "worker@rig" },
      // Spec 0011 W1: a claim-restored typed gate carries a wake.
      body: JSON.stringify({ state: "blocked", ...(cleared ? {} : { wakeAfterSeconds: 3600 }) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ blockedOn: cleared ? null : "external:old-gate" });
  });

  it.each([
    ["wake retry", "human", false], ["wake retry", "typed", false],
    ["destination fallback", "human", false], ["destination fallback", "typed", false],
    ["wake retry", "human", true], ["wake retry", "typed", true],
    ["destination fallback", "human", true], ["destination fallback", "typed", true],
  ] as const)("keeps only an unchanged claim gate through %s (%s, cleared: %s)", async (receipt, gateKind, cleared) => {
    const row = await create();
    const gate = gateKind === "human" ? "human-review@kernel" : "external:old-gate";
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: gate,
      ...(gateKind === "human" ? { summary: "await review", evidenceRef: "owned-evidence" } : {}) });
    await claim(row.qitemId);
    if (cleared) repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "in-progress", transitionNote: "gate no longer needed" });
    if (receipt === "wake retry") {
      // Supported admission: a claimed owner has a durable failed-delivery note
      // and current failed nudge. The actual scheduler must append the retry.
      repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", transitionNote: "parked-owner wake delivery failed: owned-key; controlled failure" });
      db.prepare("UPDATE queue_items SET last_nudge_result = ?, last_nudge_attempt = ? WHERE qitem_id = ?")
        .run("failed:controlled transport refusal", "2000-01-01T00:00:00.000Z", row.qitemId);
      const result = await runWakeLadderTick({ db, queueRepo: repo, attemptWake: async () => "failed:controlled retry refusal",
        resolveOrchestrator: () => "orch@rig", retryIntervalSeconds: 300, retryCap: 3, log: () => {} });
      expect(result.actions).toContainEqual({ qitemId: row.qitemId, action: "retry", target: "worker@rig" });
      expect(repo.listTransitions(row.qitemId).at(-1)?.transitionNote).toMatch(/^wake-attempt:/);
    } else {
      repo.routeToFallback(row.qitemId, "fallback@rig", "owned destination reroute");
      expect(repo.getById(row.qitemId)?.destinationSession).toBe("fallback@rig");
    }
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({ closureReason: null, closureTarget: cleared ? null : gate });
    const destination = repo.getById(row.qitemId)!.destinationSession;
    const response = await app.request(`/api/queue/${row.qitemId}/update`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": destination },
      // Spec 0011 W1: a claim-restored typed gate carries a wake.
      body: JSON.stringify({ state: "blocked", ...(cleared ? {} : gateKind === "human" ? { summary: "still awaiting review", evidenceRef: "owned-new-evidence" } : { wakeAfterSeconds: 3600 }) }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).blockedOn).toBe(cleared ? null : gate);
    expect(repo.listTransitions(row.qitemId).find((t) => t.transitionNote === "claimed"))
      .toMatchObject({ transitionNote: "claimed", closureReason: null, closureTarget: gate });
  });

  it.each([
    ["human", false], ["typed", false], ["human", true], ["typed", true],
  ] as const)("keeps only an unchanged claim gate through aggregate escalation refresh (%s, cleared: %s)", async (gateKind, cleared) => {
    const baton = async () => {
      const source = await create("relay@rig");
      const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@rig", toSession: "worker@rig", nudge: false });
      db.prepare("UPDATE queue_items SET last_nudge_result = ?, last_nudge_attempt = ? WHERE qitem_id = ?")
        .run("failed:controlled transport refusal", "2000-01-01T00:00:00.000Z", created.qitemId);
      return created;
    };
    const tick = () => runWakeLadderTick({ db, queueRepo: repo, attemptWake: async () => "failed:controlled transport refusal",
      resolveOrchestrator: () => "orch@rig", retryCap: 0, log: () => {} });
    await baton();
    await tick();
    const aggregate = repo.list().find((row) => row.tags?.includes(escalationDedupTag("worker@rig")))!;
    const post = (suffix: string, body: object) => app.request(`/api/queue/${aggregate.qitemId}/${suffix}`, {
      method: "POST", headers: { "content-type": "application/json", "X-OpenRig-Session": "orch@rig" },
      body: JSON.stringify(body),
    });
    const gate = gateKind === "human" ? "human-review@kernel" : "external:old-gate";
    // Spec 0011: on the CLI path a typed gate carries a wake (nothing on the daemon lifts it).
    expect((await post("update", { state: "blocked", blockedOn: gate,
      ...(gateKind === "human" ? { summary: "await review", evidenceRef: "owned-evidence" } : { wakeAfterSeconds: 3600 }) })).status).toBe(200);
    expect((await post("claim", {})).status).toBe(200);
    if (cleared) expect((await post("update", { state: "in-progress", transitionNote: "gate cleared" })).status).toBe(200);
    const member = await baton();
    await tick();
    const receipt = repo.listTransitions(aggregate.qitemId).at(-1)!;
    expect(receipt).toMatchObject({ state: "in-progress", actorSession: "wake-ladder@system",
      closureReason: null, closureTarget: cleared ? null : gate });
    expect(receipt.transitionNote).toBe(`wake-escalation members added: recovery-for:${member.qitemId}`);
    const response = await post("update", { state: "blocked",
      ...(cleared ? {} : gateKind === "human" ? { summary: "still waiting", evidenceRef: "owned-new-evidence" } : { wakeAfterSeconds: 3600 }) });
    expect(response.status).toBe(200);
    expect((await response.json()).blockedOn).toBe(cleared ? null : gate);
  });

  it("rolls back the complete park exit if recording the claim fails", async () => {
    const row = await create();
    repo.update({ qitemId: row.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: "external:owned-window", wakeAfterSeconds: 90 });
    const before = rows();
    db.exec("CREATE TRIGGER reject_owned_claim BEFORE INSERT ON queue_transitions WHEN NEW.state = 'in-progress' BEGIN SELECT RAISE(ABORT, 'owned claim rejected'); END");
    const response = await claim(row.qitemId);
    expect(response.status).toBe(500);
    expect(rows()).toEqual(before);
    expect(jobs.getById(timerFor(row.qitemId))?.state).toBe("active");
  });

  it("preserves the ordinary pending claim and its audit receipt", async () => {
    const row = await create();
    const response = await claim(row.qitemId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "in-progress", blockedOn: null });
    expect(repo.listTransitions(row.qitemId).at(-1)).toMatchObject({ state: "in-progress", actorSession: "worker@rig", transitionNote: "claimed" });
  });
});
