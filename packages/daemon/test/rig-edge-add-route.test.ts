// Spec 0008: POST /api/rigs/:rigId/edges adds one edge between two EXISTING nodes of a rig, the
// cross-pod case the expand and add-member paths cannot reach. Only an edge row is written: no node,
// session or binding changes, so the rig ID and every seat's conversation are kept.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";

describe("POST /api/rigs/:rigId/edges", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seedFactory(name = "cortex") {
    const rig = setup.rigRepo.createRig(name);
    const lead = setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/tmp" });
    const build = setup.rigRepo.addNode(rig.id, "dev.build", { runtime: "claude-code", cwd: "/tmp" });
    const r1 = setup.rigRepo.addNode(rig.id, "review.r1", { runtime: "claude-code", cwd: "/tmp" });
    return { rig, lead, build, r1 };
  }

  function post(rigId: string, body: unknown) {
    return setup.app.request(`/api/rigs/${rigId}/edges`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function counts() {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    return { nodes: n("nodes"), sessions: n("sessions"), bindings: n("bindings"), edges: n("edges") };
  }

  it("adds a cross-pod edge between two existing nodes and touches nothing else", async () => {
    const { rig, lead, build } = seedFactory();
    const before = counts();
    const res = await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "delegates_to" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: "created", edge: { sourceId: lead.id, targetId: build.id, kind: "delegates_to" } });
    expect(counts()).toEqual({ ...before, edges: before.edges + 1 });
    const stored = setup.rigRepo.getRig(rig.id)!;
    expect(stored.rig.id).toBe(rig.id);
    expect(stored.edges).toEqual([expect.objectContaining({ sourceId: lead.id, targetId: build.id, kind: "delegates_to" })]);
  });

  it("a repeat is idempotent: it returns the existing edge and writes nothing", async () => {
    const { rig } = seedFactory();
    const first = await (await post(rig.id, { from: "review.r1", to: "dev.build", kind: "can_observe" })).json();
    const before = counts();
    const res = await post(rig.id, { from: "review.r1", to: "dev.build", kind: "can_observe" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "exists", edge: { id: first.edge.id } });
    expect(counts()).toEqual(before);
  });

  it("rejects an unknown endpoint, a node of another rig and a bad kind before any write", async () => {
    const { rig } = seedFactory();
    const other = setup.rigRepo.createRig("other");
    setup.rigRepo.addNode(other.id, "dev.elsewhere", { runtime: "claude-code", cwd: "/tmp" });
    const before = counts();
    const unknown = await post(rig.id, { from: "orch.lead", to: "dev.ghost", kind: "delegates_to" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ ok: false, code: "node_not_found" });
    const foreign = await post(rig.id, { from: "orch.lead", to: "dev.elsewhere", kind: "delegates_to" });
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toMatchObject({ ok: false, code: "node_not_found" });
    const badKind = await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "befriends" });
    expect(badKind.status).toBe(400);
    expect(await badKind.json()).toMatchObject({ ok: false, code: "invalid_kind" });
    const missing = await post(rig.id, { from: "orch.lead", kind: "delegates_to" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, code: "validation_failed" });
    expect(counts()).toEqual(before);
  });

  it("whoami shows the new edge at once, with no relaunch", async () => {
    const { rig, lead } = seedFactory();
    await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "delegates_to" });
    const whoami = new WhoamiService({
      db,
      rigRepo: setup.rigRepo,
      sessionRegistry: new SessionRegistry(db),
      transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true }),
    });
    expect(whoami.resolve({ nodeId: lead.id })?.edges.outgoing).toEqual([
      expect.objectContaining({ kind: "delegates_to", to: expect.objectContaining({ logicalId: "dev.build" }) }),
    ]);
  });

  // Review r1 MUST-FIX: the spec path refuses self-edges and launch-order cycles; restore silently
  // drops the nodes of either. The route refuses both before any write.
  it("refuses a self-edge before any write (400 self_edge)", async () => {
    const { rig } = seedFactory();
    const before = counts();
    const res = await post(rig.id, { from: "dev.build", to: "dev.build", kind: "delegates_to" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "self_edge" });
    // Any kind, as the spec validator refuses it regardless of kind.
    expect((await post(rig.id, { from: "dev.build", to: "dev.build", kind: "can_observe" })).status).toBe(400);
    expect(counts()).toEqual(before);
  });

  it("refuses a launch-dependency edge that closes a cycle (400 cycle); a non-launch edge back is fine", async () => {
    const { rig } = seedFactory();
    expect((await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "delegates_to" })).status).toBe(201);
    const before = counts();
    const reverse = await post(rig.id, { from: "dev.build", to: "orch.lead", kind: "delegates_to" });
    expect(reverse.status).toBe(400);
    expect(await reverse.json()).toMatchObject({ ok: false, code: "cycle" });
    // spawned_by launches the TARGET first: orch.lead spawned_by dev.build puts dev.build before orch.lead.
    const spawned = await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "spawned_by" });
    expect(spawned.status).toBe(400);
    expect(await spawned.json()).toMatchObject({ ok: false, code: "cycle" });
    expect(counts()).toEqual(before);
    expect((await post(rig.id, { from: "dev.build", to: "orch.lead", kind: "can_observe" })).status).toBe(201);
  });

  it("refuses an unknown rig (404) and an archived rig (409) before any write", async () => {
    const { rig } = seedFactory();
    const before = counts();
    const ghost = await post("01NOSUCHRIG", { from: "orch.lead", to: "dev.build", kind: "delegates_to" });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toMatchObject({ ok: false, code: "rig_not_found" });
    setup.rigRepo.archiveRig(rig.id);
    const archived = await post(rig.id, { from: "orch.lead", to: "dev.build", kind: "delegates_to" });
    expect(archived.status).toBe(409);
    expect(await archived.json()).toMatchObject({ ok: false, code: "rig_archived" });
    expect(counts()).toEqual(before);
  });
});
