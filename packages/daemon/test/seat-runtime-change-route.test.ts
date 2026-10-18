import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Spec 0005: the routes take the caller from the transport identity (X-OpenRig-Session), never from the body, and map
// the runtime-change refusals to HTTP statuses.

describe("spec 0005: runtime-change routes", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db, { tmux: {} as unknown as TmuxAdapter });
    app = setup.app;
    const kernel = setup.rigRepo.createRig("kernel");
    setup.rigRepo.addNode(kernel.id, "operator.agent", { runtime: "codex" });
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%1" });
  });

  const post = (path: string, body: unknown, sender?: string) => app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": sender } : {}) },
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

  it("the operator's transport identity reaches the service: a change without --approval is 400", async () => {
    const res = await post("/api/seat/handover/dev-impl%40seat-rig", change, "operator-agent@kernel");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "runtime_change_invalid" });
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
