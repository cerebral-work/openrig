import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

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
});
