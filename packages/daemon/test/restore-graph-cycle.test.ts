// Spec 0014 (CER-2976): a rig whose launch-dependency edges form a cycle must never restore `ok: true` with seats
// missing. Every seat that can be ordered launches; each seat in or behind a cycle gets awaiting-decision, naming the
// cycle edges. `rig edge add` refuses such edges since #12, so the stored graph is written directly here, as a rig
// stored before #12, or grown by an unchecked expand, would hold it.
import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { RestoreNodeResult } from "../src/domain/types.js";
import { removeRigEdge } from "../src/domain/rig-edge-add.js";

const SEATS = ["dev.build", "dev.qa", "ops.mon", "orch.lead"];

function harness(edges: Array<[string, "delegates_to" | "spawned_by", string]>) {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const tmux = {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    getPanePid: vi.fn(async () => 1234),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const orch = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture, checkpointStore, nodeLauncher, tmuxAdapter: tmux,
    claudeResume: { canResume: () => false, resume: vi.fn() } as unknown as ClaudeResumeAdapter,
    codexResume: { canResume: () => false, resume: vi.fn() } as unknown as CodexResumeAdapter,
  });
  const rig = rigRepo.createRig("r-cycle");
  const ids = new Map(SEATS.map((logicalId) => [logicalId, rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime: "claude-code" }).id]));
  for (const [from, kind, to] of edges) rigRepo.addEdge(rig.id, ids.get(from)!, ids.get(to)!, kind);
  const restore = async () => {
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const result = await orch.restore(snap.id);
    const sessions = new Map(SEATS.map((logicalId) => [logicalId,
      (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(ids.get(logicalId)) as { n: number }).n]));
    db.close();
    if (!result.ok) throw new Error(`restore refused: ${result.code}`);
    return { result: result.result, sessions, byId: new Map<string, RestoreNodeResult>(result.result.nodes.map((n) => [n.logicalId, n])) };
  };
  const removeEdge = (from: string, kind: string, to: string) => removeRigEdge(rigRepo, eventBus, { rigId: rig.id, from, to, kind, by: null });
  return { restore, removeEdge, rigId: rig.id };
}

const CYCLE = /^restore_graph_cycle: (.+); no session was started; remove one of these edges with: rig edge remove \S+ <from> <to> --kind <kind>, then restore\.$/;
const cycleEdges = (node: RestoreNodeResult | undefined) => node?.error?.match(CYCLE)?.[1]?.split(", ");

describe("restore with a launch-dependency cycle (spec 0014)", () => {
  it("control: an acyclic rig restores every seat, none held for a cycle", async () => {
    const { byId } = await harness([["orch.lead", "delegates_to", "dev.build"]]).restore();
    expect([...byId.keys()].sort()).toEqual(SEATS);
    for (const node of byId.values()) expect(node.error ?? "").not.toMatch(/restore_graph_cycle/);
  });

  it("a self-edge: the seat is held awaiting-decision naming the edge; every other seat launches", async () => {
    const { result, byId, sessions } = await harness([["dev.qa", "delegates_to", "dev.qa"]]).restore();
    expect([...byId.keys()].sort()).toEqual(SEATS);
    expect(byId.get("dev.qa")).toMatchObject({ status: "awaiting-decision" });
    expect(sessions.get("dev.qa")).toBe(0);
    expect(sessions.get("orch.lead")).toBeGreaterThan(0);
    expect(cycleEdges(byId.get("dev.qa"))).toEqual(["dev.qa delegates_to dev.qa"]);
    for (const seat of ["dev.build", "ops.mon", "orch.lead"]) expect(byId.get(seat)!.error ?? "").not.toMatch(/restore_graph_cycle/);
    expect(result.rigResult).toBe("partially_restored");
  });

  it("a two-seat delegates_to cycle holds both seats and the seat behind them, naming the cycle edges", async () => {
    const { byId } = await harness([
      ["orch.lead", "delegates_to", "dev.build"],
      ["dev.build", "delegates_to", "orch.lead"],
      ["dev.build", "delegates_to", "dev.qa"],
    ]).restore();
    expect([...byId.keys()].sort()).toEqual(SEATS);
    const cycle = ["dev.build delegates_to orch.lead", "orch.lead delegates_to dev.build"];
    for (const seat of ["orch.lead", "dev.build", "dev.qa"]) {
      expect(byId.get(seat)).toMatchObject({ status: "awaiting-decision" });
      expect(cycleEdges(byId.get(seat))).toEqual(cycle);
    }
    expect(byId.get("ops.mon")!.error ?? "").not.toMatch(/restore_graph_cycle/);
  });

  it("CER-2981: the held seat's reason names rig edge remove with the rig's id; removing one cycle edge lets restore launch every seat it held", async () => {
    const cyclic = [["orch.lead", "delegates_to", "dev.build"], ["dev.build", "delegates_to", "orch.lead"], ["dev.build", "delegates_to", "dev.qa"]] as
      Array<[string, "delegates_to", string]>;
    const held = harness(cyclic);
    const { byId: heldById } = await held.restore();
    expect(heldById.get("orch.lead")!.error).toContain(`remove one of these edges with: rig edge remove ${held.rigId} <from> <to> --kind <kind>, then restore.`);

    const fixed = harness(cyclic);
    expect(fixed.removeEdge("dev.build", "delegates_to", "orch.lead")).toMatchObject({ ok: true, status: "removed" });
    const { byId, sessions } = await fixed.restore();
    for (const seat of ["orch.lead", "dev.build", "dev.qa"]) {
      expect(byId.get(seat)!.error ?? "").not.toMatch(/restore_graph_cycle/);
      expect(sessions.get(seat)).toBeGreaterThan(0);
    }
  });

  it("a spawned_by cycle holds both seats, naming the edges as stored", async () => {
    const { byId } = await harness([
      ["dev.build", "spawned_by", "orch.lead"],
      ["orch.lead", "spawned_by", "dev.build"],
    ]).restore();
    expect([...byId.keys()].sort()).toEqual(SEATS);
    for (const seat of ["orch.lead", "dev.build"]) {
      expect(byId.get(seat)).toMatchObject({ status: "awaiting-decision" });
      expect(cycleEdges(byId.get(seat))).toEqual(["dev.build spawned_by orch.lead", "orch.lead spawned_by dev.build"]);
    }
    for (const seat of ["dev.qa", "ops.mon"]) expect(byId.get(seat)!.error ?? "").not.toMatch(/restore_graph_cycle/);
  });

  it("a rig whose every seat sits in one cycle holds them all and rolls up partially_restored, not failed", async () => {
    const { result, byId } = await harness([
      ["orch.lead", "delegates_to", "dev.build"],
      ["dev.build", "delegates_to", "dev.qa"],
      ["dev.qa", "delegates_to", "ops.mon"],
      ["ops.mon", "delegates_to", "orch.lead"],
    ]).restore();
    expect([...byId.keys()].sort()).toEqual(SEATS);
    for (const node of byId.values()) expect(node).toMatchObject({ status: "awaiting-decision" });
    expect(result.rigResult).toBe("partially_restored");
  });

  it("a seat behind one cycle names only that cycle's edges, not an unrelated cycle's", async () => {
    const { byId } = await harness([
      ["orch.lead", "delegates_to", "dev.build"],
      ["dev.build", "delegates_to", "orch.lead"],
      ["dev.build", "delegates_to", "dev.qa"],
      ["ops.mon", "delegates_to", "ops.mon"],
    ]).restore();
    expect(cycleEdges(byId.get("dev.qa"))).toEqual(["dev.build delegates_to orch.lead", "orch.lead delegates_to dev.build"]);
    expect(cycleEdges(byId.get("ops.mon"))).toEqual(["ops.mon delegates_to ops.mon"]);
  });
});
