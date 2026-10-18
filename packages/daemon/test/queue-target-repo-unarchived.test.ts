// Spec 0009: target_repo validation reads the workspace of the one UNARCHIVED rig named by the source
// session, never an archived rig of the same name (a lead swap archives a rig and reuses its name).
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { queueRoutes } from "../src/routes/queue.js";

function makeHarness() {
  const db = createFullTestDb();
  migrate(db, [workspacePrimitiveSchema]); // the full fixture omits workspace_json; workspace suites migrate it inline
  const rigRepo = new RigRepository(db);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("queueRepo", repo);
    set("rigRepo", rigRepo);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const create = (targetRepo: string) => app.request("/api/queue/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@rig-a" },
    body: JSON.stringify({ sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "x", targetRepo, nudge: false }),
  });
  const workspace = (rigId: string, repo: string) => {
    rigRepo.setRigWorkspace(rigId, { root: "/w", repos: [{ name: repo, path: "/w/" + repo }] } as never);
    // Control: the workspace must read back, or validation is skipped and nothing here can fail.
    expect(rigRepo.getRigWorkspace(rigId)?.repos.map((r) => r.name)).toEqual([repo]);
  };
  return { db, rigRepo, create, workspace };
}

describe("queue target_repo validation with reused rig names", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h?.db.close());

  it("validates against the live rig's workspace, not an archived same-name rig's", async () => {
    h = makeHarness();
    const old = h.rigRepo.createRig("rig-a");
    h.workspace(old.id, "repo-old");
    h.rigRepo.archiveRig(old.id);
    h.workspace(h.rigRepo.createRig("rig-a").id, "repo-new");
    expect((await h.create("repo-new")).status).toBe(201);
    const refused = await h.create("repo-old");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "unknown_target_repo" });
  });

  it("two live rigs share the source's rig name: rig_ambiguous, nothing picked", async () => {
    h = makeHarness();
    for (let i = 0; i < 2; i++) h.workspace(h.rigRepo.createRig("rig-a").id, "repo-new");
    const res = await h.create("repo-new");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "rig_ambiguous" });
  });
});
