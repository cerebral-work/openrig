// Spec 0014 (CER-2976) site 2: growing an existing rig (`rig expand` with crossPodEdges, or a member added with
// pod-local edges) is checked against the rig's WHOLE launch-dependency graph before anything is written, as
// `rig edge add` is. A cycle is refused, naming its edges, and the rig is unchanged.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";

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
    expect(result.error).toMatch(/Nothing was written\. There is no edge-removal command yet: rig remove <rigId> <seat> drops a seat together with its edges\.$/);
    expect(shape(rig.id)).toEqual(before);
  });
});
