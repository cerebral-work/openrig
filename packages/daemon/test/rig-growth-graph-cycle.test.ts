// Spec 0014 (CER-2976) site 2: growing an existing rig (`rig expand` with crossPodEdges, or a member added with
// pod-local edges) is checked against the rig's WHOLE launch-dependency graph before anything is written, as
// `rig edge add` is. A cycle is refused, naming its edges, and the rig is unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import { removeRigEdge } from "../src/domain/rig-edge-add.js";

describe("growing an existing rig never closes a launch-dependency cycle (spec 0014)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => db.close());

  const pod = (id: string, members: string[], edges: ExpansionRequest["pod"]["edges"] = []): ExpansionRequest["pod"] => ({
    id, label: id,
    members: members.map((member) => ({ id: member, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" })),
    edges,
  });
  const shape = (rigId: string) => {
    const rig = setup.rigRepo.getRig(rigId)!;
    const logical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
    return {
      nodes: rig.nodes.map((n) => n.logicalId).sort(),
      edges: rig.edges.map((e) => `${logical.get(e.sourceId)} ${e.kind} ${logical.get(e.targetId)}`).sort(),
      pods: (db.prepare("SELECT namespace FROM pods WHERE rig_id = ? ORDER BY namespace").all(rigId) as Array<{ namespace: string }>).map((p) => p.namespace),
    };
  };

  it("CER-3002: an expand that lists a pod-local edge and a cross-pod edge twice stores each once", async () => {
    const rig = setup.rigRepo.createRig("grow-dup-edges");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("orch", ["lead"]) })).ok).toBe(true);
    const twice = { from: "impl", to: "qa", kind: "can_observe" };
    const result = await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("dev", ["impl", "qa"], [twice, twice]),
      crossPodEdges: [{ from: "orch.lead", to: "dev.impl", kind: "delegates_to" }, { from: "orch.lead", to: "dev.impl", kind: "delegates_to" }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(shape(rig.id).edges).toEqual(["dev.impl can_observe dev.qa", "orch.lead delegates_to dev.impl"]);
  });

  it("control: a one-way cross-pod edge to an existing seat is accepted", async () => {
    const rig = setup.rigRepo.createRig("grow-control");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("orch", ["lead"]) })).ok).toBe(true);
    const result = await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("dev", ["impl"]),
      crossPodEdges: [{ kind: "delegates_to", from: "orch.lead", to: "dev.impl" }] });
    expect(result.ok).toBe(true);
    expect(shape(rig.id).edges).toEqual(["orch.lead delegates_to dev.impl"]);
  });

  it("expand refuses cross-pod edges both ways between a new and an existing seat, and writes nothing", async () => {
    const rig = setup.rigRepo.createRig("grow-two-way");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("orch", ["lead"]) })).ok).toBe(true);
    const before = shape(rig.id);
    const result = await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("dev", ["impl"]), crossPodEdges: [
      { kind: "delegates_to", from: "orch.lead", to: "dev.impl" },
      { kind: "delegates_to", from: "dev.impl", to: "orch.lead" },
    ] });
    expect(result).toMatchObject({ ok: false, code: "cycle_error" });
    if (result.ok) return;
    expect(result.error).toContain("dev.impl delegates_to orch.lead, orch.lead delegates_to dev.impl");
    expect(result.error).toContain("Leave one of the new edges out and retry.");
    expect(shape(rig.id)).toEqual(before);
  });

  it("expand refuses a cycle that closes through an edge the rig already has, naming all three edges", async () => {
    const rig = setup.rigRepo.createRig("grow-through-existing");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id,
      pod: pod("orch", ["lead", "peer"], [{ kind: "delegates_to", from: "lead", to: "peer" }]) })).ok).toBe(true);
    const before = shape(rig.id);
    const result = await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("dev", ["impl"]), crossPodEdges: [
      { kind: "delegates_to", from: "orch.peer", to: "dev.impl" },
      { kind: "delegates_to", from: "dev.impl", to: "orch.lead" },
    ] });
    expect(result).toMatchObject({ ok: false, code: "cycle_error" });
    if (result.ok) return;
    expect(result.error).toContain("dev.impl delegates_to orch.lead, orch.lead delegates_to orch.peer, orch.peer delegates_to dev.impl");
    expect(shape(rig.id)).toEqual(before);
  });

  it("a member added with pod-local edges that close a cycle with its pod-mates is refused, and writes nothing", async () => {
    const rig = setup.rigRepo.createRig("grow-member");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id,
      pod: pod("dev", ["a", "b"], [{ kind: "delegates_to", from: "a", to: "b" }]) })).ok).toBe(true);
    const before = shape(rig.id);
    const added = await setup.podInstantiator.addMemberToPod(rig.id, "dev",
      { id: "c", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }, ".",
      { edges: [{ kind: "delegates_to", from: "b", to: "c" }, { kind: "delegates_to", from: "c", to: "a" }] });
    expect(added).toMatchObject({ ok: false, code: "cycle_error" });
    if (added.ok || !("message" in added)) return;
    expect(added.message).toContain("dev.a delegates_to dev.b, dev.b delegates_to dev.c, dev.c delegates_to dev.a");
    expect(shape(rig.id)).toEqual(before);
  });

  it("a rig that already holds a cycle refuses any growth, as `rig edge add` does, naming the existing edges", async () => {
    const rig = setup.rigRepo.createRig("grow-already-cyclic");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("orch", ["lead", "peer"]) })).ok).toBe(true);
    // Stored before the checks existed: written directly, as `rig edge add` now refuses it.
    const ids = new Map(setup.rigRepo.getRig(rig.id)!.nodes.map((n) => [n.logicalId, n.id]));
    setup.rigRepo.addEdge(rig.id, ids.get("orch.lead")!, ids.get("orch.peer")!, "delegates_to");
    setup.rigRepo.addEdge(rig.id, ids.get("orch.peer")!, ids.get("orch.lead")!, "delegates_to");
    const before = shape(rig.id);
    const result = await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("ops", ["mon"]) });
    expect(result).toMatchObject({ ok: false, code: "cycle_error" });
    if (result.ok) return;
    expect(result.error).toContain("This rig already holds a launch-order cycle: orch.lead delegates_to orch.peer, orch.peer delegates_to orch.lead");
    expect(result.error).toContain(`Nothing was written. Remove one of these edges with: rig edge remove ${rig.id} <from> <to> --kind <kind>, then retry.`);
    expect(shape(rig.id)).toEqual(before);
    // CER-2981: removing one cycle edge lets the rig grow again.
    expect(removeRigEdge(setup.rigRepo, setup.eventBus, { rigId: rig.id, from: "orch.peer", to: "orch.lead", kind: "delegates_to", by: null }))
      .toMatchObject({ ok: true, status: "removed" });
    expect((await setup.rigExpansionService.expand({ rigId: rig.id, pod: pod("ops", ["mon"]) })).ok).toBe(true);
  });
});

// Review r1 on #17: the routes that reach the guard. F1: materialize-only with NO target rig wrote a pod-local cycle
// (201, the seats and both edges stored) while import refused the same spec. E and F are r1's probe cases, lifted.
describe("the routes refuse a launch-dependency cycle with 400 cycle_error and write nothing (spec 0014)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => db.close());

  const terminal = (id: string) => ({ id, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" });
  const yamlMember = (id: string) => [`      - id: ${id}`, '        agent_ref: "builtin:terminal"', '        profile: "none"', "        runtime: terminal", "        cwd: /"];
  const json = async (res: Response) => await res.json() as Record<string, unknown>;

  it("F1: materialize-only with no target rig refuses a pod-local cycle, storing no rig", async () => {
    const yaml = ['version: "0.2"', "name: cyc-mat", "pods:", "  - id: crew", "    label: Crew", "    members:",
      ...yamlMember("a"), ...yamlMember("b"), "    edges:",
      "      - kind: delegates_to", "        from: a", "        to: b",
      "      - kind: delegates_to", "        from: b", "        to: a", "edges: []"].join("\n");
    const res = await setup.app.request("/api/rigs/import/materialize", {
      method: "POST", headers: { "Content-Type": "text/yaml", "X-Rig-Root": "/tmp" }, body: yaml,
    });
    const body = await json(res);
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ ok: false, code: "cycle_error" });
    expect(String(body["message"])).toContain("crew.a delegates_to crew.b, crew.b delegates_to crew.a");
    expect(String(body["message"])).toContain("Leave one of the new edges out and retry.");
    expect(setup.rigRepo.findRigsByName("cyc-mat")).toEqual([]);
  });

  it("E: the add-member route refuses pod-local edges that close a cycle with pod-mates", async () => {
    const rig = setup.rigRepo.createRig("r1-add");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id,
      pod: { id: "dev", label: "dev", members: [terminal("a"), terminal("b")], edges: [{ kind: "delegates_to", from: "a", to: "b" }] } })).ok).toBe(true);
    const before = setup.rigRepo.getRig(rig.id)!;
    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev/members`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member: { id: "c", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }, rigRoot: ".",
        edges: [{ kind: "delegates_to", from: "b", to: "c" }, { kind: "delegates_to", from: "c", to: "a" }] }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ ok: false, code: "cycle_error" });
    const after = setup.rigRepo.getRig(rig.id)!;
    expect([after.nodes.length, after.edges.length]).toEqual([before.nodes.length, before.edges.length]);
  });

  it("F: materialize with X-Target-Rig-Id refuses a cycle that closes through an existing edge", async () => {
    const rig = setup.rigRepo.createRig("r1-mat");
    expect((await setup.rigExpansionService.expand({ rigId: rig.id,
      pod: { id: "orch", label: "orch", members: [terminal("lead"), terminal("peer")], edges: [{ kind: "delegates_to", from: "lead", to: "peer" }] } })).ok).toBe(true);
    const before = setup.rigRepo.getRig(rig.id)!;
    const yaml = ['version: "0.2"', "name: r1-mat", "pods:", "  - id: dev", "    label: Dev", "    members:", ...yamlMember("impl"),
      "    edges: []", "edges:",
      "  - kind: delegates_to", "    from: orch.peer", "    to: dev.impl",
      "  - kind: delegates_to", "    from: dev.impl", "    to: orch.lead"].join("\n");
    const res = await setup.app.request("/api/rigs/import/materialize", {
      method: "POST", headers: { "Content-Type": "text/yaml", "X-Rig-Root": "/tmp", "X-Target-Rig-Id": rig.id }, body: yaml,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ ok: false, code: "cycle_error" });
    const after = setup.rigRepo.getRig(rig.id)!;
    expect([after.nodes.length, after.edges.length]).toEqual([before.nodes.length, before.edges.length]);
  });
});
