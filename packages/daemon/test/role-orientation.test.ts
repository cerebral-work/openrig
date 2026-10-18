import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestApp, createFullTestDb } from "./helpers/test-app.js";
import { validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { resolveStartup } from "../src/domain/startup-resolver.js";

describe("explicit role orientation", () => {
  it("validates the marker and preserves it through normalization and startup layering", () => {
    const spec = { name: "worker", version: "1.0", startup: { files: [
      { path: "instructions.md", orientation: "role" }, { path: "setup.md" },
    ] } };
    expect(validateAgentSpec(spec).valid).toBe(true);
    const normalized = normalizeAgentSpec(spec);
    const resolved = resolveStartup({ specStartup: normalized.startup });
    expect(resolved.files[0]).toHaveProperty("orientation", "role");
    expect(resolved.files[1]).not.toHaveProperty("orientation");
    for (const orientation of ["roles", "", null, true, {}]) {
      expect(validateAgentSpec({ ...spec, startup: { files: [{ path: "role.md", orientation }] } }).valid).toBe(false);
    }
  });
});

describe("queue whoami role binding", () => {
  let f: ReturnType<typeof createTestApp>;
  let root: string;
  let a: string;
  let b: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "role-binding-"));
    const db = createFullTestDb();
    f = createTestApp(db, { appDeps: { db, queueRepo: new QueueRepository(db, new EventBus(db)) } });
    const rig = f.rigRepo.createRig("roles");
    a = f.rigRepo.addNode(rig.id, "a", { runtime: "codex", cwd: root }).id;
    b = f.rigRepo.addNode(rig.id, "b", { runtime: "claude-code", cwd: root }).id;
    f.sessionRegistry.registerSession(a, "a@roles");
    f.sessionRegistry.registerSession(b, "b@roles");
  });
  afterEach(() => { f.db.close(); rmSync(root, { recursive: true, force: true }); });
  const recordedAt = "2026-01-02 03:04:05";
  function record(node: string, files: unknown) {
    f.db.prepare("INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime, created_at) VALUES (?, '[]', ?, '[]', 'codex', ?)")
      .run(node, typeof files === "string" ? files : JSON.stringify(files), recordedAt);
  }
  function file(name: string, marked = true) {
    const absolutePath = join(root, name);
    writeFileSync(absolutePath, "role bytes are not API content");
    return { path: name, absolutePath, ownerRoot: root, ...(marked ? { orientation: "role" } : {}) };
  }
  async function role(session = "a@roles", query = session) {
    const response = await f.app.request("/api/queue/whoami?session=" + encodeURIComponent(query), { headers: { "X-OpenRig-Session": session } });
    expect(response.status).toBe(200);
    return (await response.json()).role;
  }
  // ---------- session names shared across rigs (spec 0009; revenant's gap 2) ----------
  function leadSeat(rigName: string, opts: { archived?: boolean } = {}) {
    const rig = f.rigRepo.createRig(rigName);
    const node = f.rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: root }).id;
    f.sessionRegistry.registerSession(node, `orch-lead@${rigName}`);
    if (opts.archived) f.rigRepo.archiveRig(rig.id);
    return { rigId: rig.id, node };
  }
  async function roleWithNode(session: string, nodeId: string) {
    const response = await f.app.request(`/api/queue/whoami?session=${encodeURIComponent(session)}&nodeId=${encodeURIComponent(nodeId)}`, { headers: { "X-OpenRig-Session": session } });
    expect(response.status).toBe(200);
    return (await response.json()).role;
  }

  it("revenant's shape: two archived rigs and one live rig share a session; queue whoami resolves the live node (spec 0009)", async () => {
    leadSeat("revenant", { archived: true });
    leadSeat("revenant", { archived: true });
    const live = leadSeat("revenant");
    record(live.node, [file("lead.md")]);
    expect(await role("orch-lead@revenant")).toMatchObject({ state: "present", files: [{ path: "lead.md" }] });
  });

  it("two live rigs share a session: the role names rig_ambiguous and both rigs (spec 0009)", async () => {
    const one = leadSeat("twin");
    const two = leadSeat("twin");
    const answer = await role("orch-lead@twin");
    expect(answer.state).toBe("unknown");
    expect(answer.reason).toContain("rig_ambiguous");
    expect(answer.reason).toContain(one.rigId);
    expect(answer.reason).toContain(two.rigId);
  });

  it("the caller's node id disambiguates its own session, and only its own (spec 0009)", async () => {
    const one = leadSeat("twin");
    leadSeat("twin");
    record(one.node, [file("one.md")]);
    expect(await roleWithNode("orch-lead@twin", one.node)).toMatchObject({ state: "present", files: [{ path: "one.md" }] });
    // A node whose session is someone else's does not stand in for the caller.
    expect((await roleWithNode("orch-lead@twin", a)).reason).toContain("rig_ambiguous");
  });

  it("exposes only the caller's explicitly marked entries, independently of work and shared cwd", async () => {
    const own = file("a.md"), other = file("b.md");
    record(a, [own, file("setup.md", false)]);
    record(b, [other]);
    const answer = await role("a@roles", "b@roles");
    expect(answer).toMatchObject({ state: "present", recordedAt, files: [{ path: "a.md", ownerRoot: root, absolutePath: own.absolutePath, resolvedPath: own.absolutePath }] });
    expect(JSON.stringify(answer)).not.toContain("b.md");
    expect(JSON.stringify(answer)).not.toContain("setup.md");
    expect(JSON.stringify(answer)).not.toContain("role bytes");
    expect((await role("b@roles")).files[0].path).toBe("b.md");
  });
  it("distinguishes no record, unmarked old record, missing role, and multiple explicit roles", async () => {
    expect((await role()).state).toBe("no-record");
    record(a, [file("role.md", false)]);
    expect((await role()).state).toBe("not-declared");
    const one = file("one.md"), two = file("two.md");
    rmSync(two.absolutePath);
    record(a, [one, two]);
    const result = await role();
    expect(result.state).toBe("missing");
    expect(result.files.map((x: any) => [x.path, x.state])).toEqual([["one.md", "present"], ["two.md", "missing"]]);
  });
  it.each(["not json", "null", "{}", "[null]", '[{"orientation":"role"}]', '[{"orientation":"roles"}]'])("keeps malformed record %s unknown", async (raw) => {
    record(a, raw);
    expect(await role()).toMatchObject({ state: "unknown", files: [] });
  });
  it("preserves binding provenance while re-anchoring an old packaged role", async () => {
    const path = "guidance/role.md";
    const ownerRoot = "/old/node_modules/@openrig/cli/daemon/specs/rigs/launch/kernel/agents/advisor/lead";
    record(a, [{ path, ownerRoot, absolutePath: ownerRoot + "/" + path, orientation: "role" }]);
    const result = await role();
    expect(result).toMatchObject({ state: "present", recordedAt });
    expect(result.note).toContain("record write");
    expect(result.note).toContain("not");
    expect(result.files[0]).toMatchObject({ ownerRoot, absolutePath: ownerRoot + "/" + path });
    expect(result.files[0].resolvedPath).toContain("/packages/daemon/specs/rigs/launch/kernel/agents/advisor/lead/guidance/role.md");
    expect(result.files[0].resolvedPath).not.toContain("/old/");
    expect(JSON.parse((f.db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id=?").get(a) as any).resolved_files_json)[0].ownerRoot).toBe(ownerRoot);
  });
  it("keeps an existing development-checkout role at its recorded path", async () => {
    const ownerRoot = join(root, "packages/daemon/specs/rigs/launch/kernel/agents/advisor/lead");
    mkdirSync(join(ownerRoot, "guidance"), { recursive: true });
    const absolutePath = join(ownerRoot, "guidance/role.md");
    writeFileSync(absolutePath, "development role");
    const original = { path: "guidance/role.md", absolutePath, ownerRoot, orientation: "role" };
    record(a, [original]);
    expect((await role()).files[0].resolvedPath).toBe(original.absolutePath);
  });
  it("keeps absent identity and unavailable storage unknown without changing queue success", async () => {
    expect((await role("absent@roles")).state).toBe("unknown");
    f.db.exec("DROP TABLE node_startup_context");
    expect((await role()).state).toBe("unknown");
  });
});
