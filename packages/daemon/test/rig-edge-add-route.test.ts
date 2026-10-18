// Spec 0008: POST /api/rigs/:rigId/edges adds one edge between two EXISTING nodes of a rig, the
// cross-pod case the expand and add-member paths cannot reach. Only an edge row is written: no node,
// session or binding changes, so the rig ID and every seat's conversation are kept.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { heldByLaunchCycles } from "../src/domain/launch-graph-cycles.js";

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

// CER-2981: DELETE /api/rigs/:rigId/edges removes one edge, the reverse of the add above, and records who removed it.
describe("DELETE /api/rigs/:rigId/edges (CER-2981)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  function seed() {
    const rig = setup.rigRepo.createRig("cortex");
    const lead = setup.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/tmp" });
    const build = setup.rigRepo.addNode(rig.id, "dev.build", { runtime: "claude-code", cwd: "/tmp" });
    const edge = setup.rigRepo.addEdge(rig.id, lead.id, build.id, "delegates_to");
    return { rig, edge };
  }
  const EDGE = { from: "orch.lead", to: "dev.build", kind: "delegates_to" };
  const del = (rigId: string, query: Record<string, string>, headers: Record<string, string> = {}) =>
    setup.app.request(`/api/rigs/${rigId}/edges?${new URLSearchParams(query)}`, { method: "DELETE", headers });
  const counts = () => {
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
    return { nodes: n("nodes"), sessions: n("sessions"), bindings: n("bindings"), edges: n("edges") };
  };
  const removed = () => (db.prepare("SELECT rig_id, payload FROM events WHERE type = 'rig.edge_removed'").all() as Array<{ rig_id: string; payload: string }>)
    .map((row) => ({ eventRigId: row.rig_id, ...JSON.parse(row.payload) as Record<string, unknown> }));

  it("removes exactly that edge, records who removed it and when, and changes nothing else", async () => {
    const { rig, edge } = seed();
    const before = counts();
    const res = await del(rig.id, EDGE, { "X-OpenRig-Session": "orch-lead@cortex" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "removed", edges: [{ id: edge.id, kind: "delegates_to" }] });
    expect(counts()).toEqual({ ...before, edges: before.edges - 1 });
    expect(removed()).toEqual([expect.objectContaining({ eventRigId: rig.id, rigId: rig.id, edgeId: edge.id, ...EDGE,
      by: { session: "orch-lead@cortex", provenance: "transport:v1" } })]);
  });

  it("records a relayed caller as relay:v1, and no caller as null", async () => {
    const first = seed();
    expect((await del(first.rig.id, EDGE, { "X-OpenRig-Session": "orch-lead@cortex", "X-OpenRig-Relay": "remote-host",
      "X-OpenRig-Provenance": "transport:v1" })).status).toBe(200);
    setup.rigRepo.addEdge(first.rig.id, first.edge.sourceId, first.edge.targetId, "delegates_to");
    expect((await del(first.rig.id, EDGE)).status).toBe(200);
    expect(removed().map((event) => event.by)).toEqual([{ session: "orch-lead@cortex", provenance: "relay:v1" }, null]);
  });

  it("a wrong kind or the reverse direction is 404 edge_not_found while the edge exists, and the edge stays (review r1 F1)", async () => {
    const { rig, edge } = seed();
    const before = counts();
    for (const query of [{ ...EDGE, kind: "can_observe" }, { ...EDGE, from: "dev.build", to: "orch.lead" }]) {
      const res = await del(rig.id, query);
      expect(res.status, JSON.stringify(query)).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    }
    expect(counts()).toEqual(before);
    expect(db.prepare("SELECT id FROM edges").all()).toEqual([{ id: edge.id }]);
    expect(removed()).toEqual([]);
  });

  it("duplicate rows of one (from, to, kind) are all removed in one call, one event each, leaving no cycle (the lead's ruling)", async () => {
    const { rig, edge } = seed();
    const twin = setup.rigRepo.addEdge(rig.id, edge.sourceId, edge.targetId, "delegates_to");
    const back = setup.rigRepo.addEdge(rig.id, edge.targetId, edge.sourceId, "delegates_to"); // closes a cycle with either twin
    const res = await del(rig.id, EDGE, { "X-OpenRig-Session": "orch-lead@cortex" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "removed", edges: [{ id: edge.id }, { id: twin.id }] });
    expect(db.prepare("SELECT id FROM edges").all()).toEqual([{ id: back.id }]);
    expect(removed().map((event) => event.edgeId).sort()).toEqual([edge.id, twin.id].sort());
    const left = setup.rigRepo.getRig(rig.id)!.edges.map((e) => ({ from: e.sourceId, to: e.targetId, kind: e.kind }));
    expect(heldByLaunchCycles(setup.rigRepo.getRig(rig.id)!.nodes.map((n) => n.id), left)).toEqual(new Map());
  });

  it("an edge already removed is 404 edge_not_found, never success, and writes nothing", async () => {
    const { rig } = seed();
    expect((await del(rig.id, EDGE)).status).toBe(200);
    const before = counts();
    const res = await del(rig.id, EDGE);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    expect(counts()).toEqual(before);
    expect(removed()).toHaveLength(1);
  });

  it("a delete that changes no row (the edge went between the lookup and the write) is edge_not_found with no event (review r1 INFO)", async () => {
    const { rig } = seed();
    const removeEdge = vi.spyOn(setup.rigRepo, "removeEdge").mockReturnValue(false);
    const res = await del(rig.id, EDGE);
    removeEdge.mockRestore();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    expect(removed()).toEqual([]);
  });

  it("rejects a missing parameter, an unknown node, a bad kind, an unknown rig and an archived rig before any write", async () => {
    const { rig } = seed();
    const before = counts();
    expect((await del(rig.id, { from: "orch.lead", to: "dev.build" })).status).toBe(400);
    expect(await (await del(rig.id, { ...EDGE, to: "dev.ghost" })).json()).toMatchObject({ code: "node_not_found" });
    expect(await (await del(rig.id, { ...EDGE, kind: "befriends" })).json()).toMatchObject({ code: "invalid_kind" });
    expect((await del("no-such-rig", EDGE)).status).toBe(404);
    setup.rigRepo.archiveRig(rig.id);
    expect((await del(rig.id, EDGE)).status).toBe(409);
    expect(counts()).toEqual(before);
    expect(removed()).toEqual([]);
  });

  it("a cross-site browser request is refused by the boundary, as for rig edge add, and the edge stays", async () => {
    const { rig } = seed();
    const res = await del(rig.id, EDGE, { Host: "127.0.0.1:7433", Origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect(counts().edges).toBe(1);
    expect(removed()).toEqual([]);
  });
});

