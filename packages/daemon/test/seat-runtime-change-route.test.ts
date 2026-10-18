import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";

// Spec 0005: the routes take the caller from the transport identity (X-OpenRig-Session), never from the body, and map
// the runtime-change refusals to HTTP statuses.

describe("spec 0005: runtime-change routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { tmux: {} as unknown as TmuxAdapter });
    app = setup.app;
    const kernel = setup.rigRepo.createRig("kernel");
    setup.rigRepo.addNode(kernel.id, "operator.agent", { runtime: "codex" });
    setup.rigRepo.addNode(kernel.id, "advisor.lead", { runtime: "codex" });
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%1" });
  });

  const post = (path: string, body: unknown, sender?: string, extra: Record<string, string> = {}) => app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": sender } : {}), ...extra },
    body: JSON.stringify(body),
  });
  const change = { reason: "r", operator: "operator-agent@kernel", runtimeChange: { toRuntime: "claude-code", toModel: "m", toPermissions: "floor" } };

  it("a runtime change without the operator's transport identity is 403, whatever the body says", async () => {
    for (const sender of [undefined, "dev-impl@seat-rig"]) {
      const res = await post("/api/seat/handover/dev-impl%40seat-rig", change, sender);
      expect(res.status, String(sender)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "runtime_change_unauthorized" });
    }
  });

  it("a relayed operator identity is relay:v1, not transport:v1, so a runtime change and a revert are 403", async () => {
    const relayed = { "X-OpenRig-Relay": "remote-host", "X-OpenRig-Provenance": "transport:v1" };
    const res = await post("/api/seat/handover/dev-impl%40seat-rig", { ...change, runtimeChange: { ...change.runtimeChange, approval: "go" } }, "operator-agent@kernel", relayed);
    expect(res.status).toBe(403);
    const revert = await post("/api/seat/runtime-revert/dev-impl%40seat-rig", { reason: "r", approval: "go" }, "operator-agent@kernel", relayed);
    expect(revert.status).toBe(403);
  });

  it("the operator's transport identity reaches the service: a change without --approval is 400", async () => {
    const res = await post("/api/seat/handover/dev-impl%40seat-rig", change, "operator-agent@kernel");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "runtime_change_invalid" });
  });

  it("F1: a discovered source is refused with --to-runtime, whatever its hint, before any change", async () => {
    for (const runtimeHint of ["unknown", "claude-code"] as const) {
      const discovered = setup.discoveryRepo.upsertDiscoveredSession({ tmuxSession: `succ-${runtimeHint}`, tmuxPane: "%9", runtimeHint, confidence: "high" });
      const body = { ...change, source: `discovered:${discovered.id}`, runtimeChange: { ...change.runtimeChange, approval: "go" } };
      const res = await post("/api/seat/handover/dev-impl%40seat-rig", body, "operator-agent@kernel");
      expect(res.status, runtimeHint).toBe(400);
      const json = await res.json() as { code: string; guidance: string };
      expect(json.code).toBe("runtime_change_invalid");
      expect(json.guidance).toContain("--source fresh");
    }
    expect(db.prepare("SELECT runtime FROM nodes WHERE logical_id = 'dev.impl'").get()).toEqual({ runtime: "codex" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_runtime_changes").get()).toEqual({ n: 0 });
  });

  it("runtime-revert: 409 with nothing to revert for the operator, 403 without its identity", async () => {
    const body = { reason: "r", approval: "go" };
    const allowed = await post("/api/seat/runtime-revert/dev-impl%40seat-rig", body, "operator-agent@kernel");
    expect(allowed.status, await allowed.clone().text()).toBe(409);
    expect(await allowed.json()).toMatchObject({ code: "runtime_revert_unavailable" });
    const refused = await post("/api/seat/runtime-revert/dev-impl%40seat-rig", body);
    expect(refused.status).toBe(403);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  const nodeId = () => (db.prepare("SELECT n.id FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE r.name = 'seat-rig'").get() as { id: string }).id;
  const seedCommitted = (generation: string | null) => db.prepare(`INSERT INTO node_runtime_changes
    (id, node_id, kind, outcome, generation_uuid, to_runtime, approval, reason, operator) VALUES ('c-1', ?, 'change', 'committed', ?, 'claude-code', 'go', 'r', 'operator-agent@kernel')`)
    .run(nodeId(), generation);

  it("runtime-declare: 403 without a kernel identity and for a relayed operator; 409 with nothing pending, for the operator and the advisor", async () => {
    const route = "/api/seat/runtime-declare/dev-impl%40seat-rig";
    expect((await post(route, {})).status).toBe(403);
    expect((await post(route, {}, "advisor-lead@kernel")).status).toBe(409);
    const relayed = { "X-OpenRig-Relay": "remote-host", "X-OpenRig-Provenance": "transport:v1" };
    expect((await post(route, {}, "operator-agent@kernel", relayed)).status).toBe(403);
    const none = await post(route, {}, "operator-agent@kernel");
    expect(none.status, await none.clone().text()).toBe(409);
    expect(await none.json()).toMatchObject({ code: "runtime_declare_not_pending" });
  });

  it("runtime-declare: 200 declares the seat's undeclared committed change and records who", async () => {
    const generation = setup.sessionRegistry.currentOccupantTenure(nodeId())?.generationUuid ?? null;
    expect(generation).not.toBeNull();
    seedCommitted(generation);
    const res = await post("/api/seat/runtime-declare/dev-impl%40seat-rig", {}, "operator-agent@kernel");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ changeId: "c-1", declaredBy: "operator-agent@kernel" });
    expect(db.prepare("SELECT declared_by FROM node_runtime_changes WHERE id = 'c-1'").get()).toEqual({ declared_by: "operator-agent@kernel" });
    const again = await post("/api/seat/runtime-declare/dev-impl%40seat-rig", {}, "operator-agent@kernel");
    expect(again.status).toBe(409);
  });

  it("the committed-state codes are JSON 500s carrying their code and guidance, never the plain-text error page", async () => {
    const committed = { ok: false as const, code: "handover_committed_with_error" as const, message: "The runtime change committed, but a step after the commit failed: boom",
      guidance: "The runtime change is COMMITTED: the seat runs claude-code. Do NOT retry, relaunch or revert to recover." };
    vi.spyOn(SeatHandoverService.prototype, "handover").mockResolvedValue(committed);
    const res = await post("/api/seat/handover/dev-impl%40seat-rig", { ...change, runtimeChange: { ...change.runtimeChange, approval: "go" } }, "operator-agent@kernel");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(committed);
    const failed = { ok: false as const, code: "runtime_declare_failed" as const, message: "oracle down", guidance: "The change stays COMMITTED." };
    vi.spyOn(SeatHandoverService.prototype, "declareRuntimeOccupant").mockResolvedValue(failed);
    const declare = await post("/api/seat/runtime-declare/dev-impl%40seat-rig", {}, "operator-agent@kernel");
    expect(declare.status).toBe(500);
    expect(await declare.json()).toEqual(failed);
  });

  it("a pending declaration reaches rig seat status and the rig nodes route as served (cw.4.3)", async () => {
    const generation = setup.sessionRegistry.currentOccupantTenure(nodeId())?.generationUuid ?? null;
    seedCommitted(generation);
    const status = await app.request("/api/seat/status/dev-impl%40seat-rig");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ pending_declaration: { change_id: "c-1", kind: "change", operator: "operator-agent@kernel" } });
    const rigId = (db.prepare("SELECT id FROM rigs WHERE name = 'seat-rig'").get() as { id: string }).id;
    const nodes = await app.request(`/api/rigs/${rigId}/nodes`);
    expect(nodes.status).toBe(200);
    const entry = (await nodes.json() as Array<{ logicalId: string; pendingDeclaration?: unknown }>).find((e) => e.logicalId === "dev.impl");
    expect(entry?.pendingDeclaration).toMatchObject({ changeId: "c-1", kind: "change", operator: "operator-agent@kernel" });

    expect((await post("/api/seat/runtime-declare/dev-impl%40seat-rig", {}, "operator-agent@kernel")).status).toBe(200);
    expect(await (await app.request("/api/seat/status/dev-impl%40seat-rig")).json()).toMatchObject({ pending_declaration: null });
  });
});
