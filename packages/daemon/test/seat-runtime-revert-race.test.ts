import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SeatHandoverService, type RuntimeChangeRequest } from "../src/domain/seat-handover-service.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { runtimeRungInventory } from "../src/domain/activity-taxonomy.js";

// Review r2 F2: a revert reads the revert slot inside the node's lifecycle lease, and its commit refuses unless the
// slot still names the change it reverts. Two reverts never both commit, and a stale revert cannot erase a newer
// change's slot. The successor launch is held at will, so the races are deterministic.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const OPERATOR = { session: "operator-agent@kernel", provenance: "transport:v1" };
const ADVISOR = { session: "advisor-lead@kernel", provenance: "transport:v1" };

function fixture(opts: { guard?: boolean; authoredRecapResolver?: (seatRef: string) => never; activityOracle?: { declareOccupantSwap: (seatNodeId: string, generation: string) => void } } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rtc-race-")));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "cwd");
  for (const d of [nodePath.join(rigRoot, "agents", "impl"), cwd]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  const spec = (runtime: string, model: string) => {
    const yaml = [`version: "0.2"`, `name: rt-rig`, `pods:`, `  - id: dev`, `    label: Dev`, `    members:`, `      - id: impl`,
      `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: ${runtime}`, `        model: ${model}`,
      `        cwd: "${cwd}"`, `    edges: []`, `edges: []`].join("\n") + "\n";
    const path = nodePath.join(rigRoot, `rig-${runtime}.yaml`);
    fs.writeFileSync(path, yaml);
    return { path, yaml };
  };

  const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
  const kernel = rigRepo.createRig("kernel");
  rigRepo.addNode(kernel.id, "operator.agent", { runtime: "codex", cwd: root });
  rigRepo.addNode(kernel.id, "advisor.lead", { runtime: "claude-code", cwd: root });
  const rig = rigRepo.createRig("rt-rig");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd, model: "gpt-5.5-codex" });
  const session = sessionRegistry.registerSession(node.id, "dev-impl@rt-rig");
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@rt-rig", tmuxPane: "%0" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'codex')").run(node.id);

  // A successor launch can be held: the next launch waits until released.
  const held: Array<() => void> = [];
  let holdNext = false;
  const launches: string[] = [];
  const adapter = (runtime: string): RuntimeAdapter => ({
    runtime,
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async () => {
      launches.push(runtime);
      if (holdNext) { holdNext = false; await new Promise<void>((release) => held.push(release)); }
      return { ok: true };
    },
    checkReady: async () => ({ ready: true }),
  } as never);
  const adapters = { codex: adapter("codex"), "claude-code": adapter("claude-code") };
  const tmux = {
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true })),
    listPanes: vi.fn(async () => [{ id: "%9", index: 0, cwd, width: 80, height: 24, active: true }]),
    killSession: vi.fn(async () => ({ ok: true })),
    respawnPane: vi.fn(async () => ({ ok: true })),
    setRemainOnExit: vi.fn(async () => ({ ok: true })),
    signalPaneProcess: vi.fn(async () => ({ ok: true })),
    isPaneDead: vi.fn(async () => true),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    capturePaneScreen: vi.fn(async () => "predecessor screen"),
    getDefaultShell: vi.fn(async () => "/bin/zsh"),
    getPaneCommand: vi.fn(async () => "zsh"),
    ...(opts.guard ? { deliveryGuard: new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name)) } : {}),
  } as unknown as TmuxAdapter;
  const memberStartup = new PodRigInstantiator({
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }),
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) }, tmuxAdapter: tmux, adapters,
  } as never);
  const service = new SeatHandoverService({
    db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, tmuxAdapter: tmux,
    runtimeAdapters: adapters, memberStartup, readinessTimeoutMs: 50, sleep: async () => {},
    authoredRecapResolver: opts.authoredRecapResolver, activityOracle: opts.activityOracle,
  });
  const change = (runtime: string, model: string): RuntimeChangeRequest => ({
    toRuntime: runtime, toModel: model, toPermissions: "floor", spec: spec(runtime, model), approval: "go",
  });
  const held1 = async (count: number) => { await vi.waitFor(() => expect(held).toHaveLength(count), { timeout: 3000 }); };
  const ledger = () => db.prepare("SELECT kind, outcome FROM node_runtime_changes WHERE node_id = ? ORDER BY created_at, rowid").all(node.id);
  const slot = () => db.prepare("SELECT change_id FROM node_runtime_revert_slots WHERE node_id = ?").get(node.id) as { change_id: string } | undefined;
  return {
    db, node, service, change, held, held1, ledger, slot, launches, eventBus, tmux: tmux as unknown as { listPanes: ReturnType<typeof vi.fn>; respawnPane: ReturnType<typeof vi.fn>; isPaneDead: ReturnType<typeof vi.fn> },
    hold: () => { holdNext = true; },
  };
}

describe("review r2 F2: runtime-revert races", () => {
  it("two overlapping reverts: exactly one commits; the commit refuses the other", async () => {
    const f = fixture();
    expect((await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: f.change("claude-code", "claude-opus-5-5") })).ok).toBe(true);
    f.hold();
    const first = f.service.revertRuntimeChange({ seatRef: "dev-impl@rt-rig", reason: "r1", approval: "go", caller: ADVISOR });
    await f.held1(1);
    f.hold();
    const second = f.service.revertRuntimeChange({ seatRef: "dev-impl@rt-rig", reason: "r2", approval: "go", caller: OPERATOR });
    await f.held1(2);
    f.held[0]!();
    expect((await first).ok).toBe(true);
    f.held[1]!();
    expect(await second).toMatchObject({ ok: false, code: "runtime_revert_unavailable" });
    expect(f.ledger()).toEqual([
      { kind: "change", outcome: "committed" }, { kind: "revert", outcome: "committed" }, { kind: "revert", outcome: "failed" }]);
    expect(f.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "codex" });
  });

  it("with the lifecycle lease, the second revert reads the slot inside it and is refused before it launches", async () => {
    const f = fixture({ guard: true });
    expect((await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: f.change("claude-code", "claude-opus-5-5") })).ok).toBe(true);
    f.hold();
    const first = f.service.revertRuntimeChange({ seatRef: "dev-impl@rt-rig", reason: "r1", approval: "go", caller: ADVISOR });
    await f.held1(1);
    const second = f.service.revertRuntimeChange({ seatRef: "dev-impl@rt-rig", reason: "r2", approval: "go", caller: OPERATOR });
    f.held[0]!();
    expect((await first).ok).toBe(true);
    expect(await second).toMatchObject({ ok: false, code: "runtime_revert_unavailable" });
    expect(f.launches).toEqual(["claude-code", "codex"]);
    expect(f.ledger()).toEqual([{ kind: "change", outcome: "committed" }, { kind: "revert", outcome: "committed" }]);
  });

  it("a stale revert after a newer change is refused at commit and leaves the newer change's slot", async () => {
    const f = fixture();
    expect((await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "a", source: "fresh", caller: OPERATOR, runtimeChange: f.change("claude-code", "claude-opus-5-5") })).ok).toBe(true);
    f.hold();
    const stale = f.service.revertRuntimeChange({ seatRef: "dev-impl@rt-rig", reason: "stale", approval: "go", caller: ADVISOR });
    await f.held1(1);
    const newer = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "b", source: "fresh", caller: OPERATOR, runtimeChange: f.change("codex", "gpt-5.5-codex-max") });
    expect(newer.ok, JSON.stringify(newer)).toBe(true);
    const newerSlot = f.slot();
    f.held[0]!();
    expect(await stale).toMatchObject({ ok: false, code: "runtime_revert_unavailable" });
    expect(f.slot()).toEqual(newerSlot);
    expect(f.db.prepare("SELECT runtime, model FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "codex", model: "gpt-5.5-codex-max" });
  });

  it("N1: a failure before the respawn says the seat was not changed and gives no --fresh --stop advice", async () => {
    const f = fixture();
    f.tmux.listPanes.mockResolvedValue([]); // resolve_pane fails before anything in the pane is touched
    const result = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") }) as { ok: boolean; guidance?: string };
    expect(result.ok).toBe(false);
    expect(f.tmux.respawnPane).not.toHaveBeenCalled();
    expect(result.guidance).toContain("resolve_pane");
    expect(result.guidance).toContain("was not changed");
    expect(result.guidance).not.toContain("--fresh --stop");
  });

  it("N1b: a retiree that was not seen to exit gets check-the-seat advice, not 'not changed'", async () => {
    const f = fixture();
    f.tmux.isPaneDead.mockResolvedValue(false); // TERM and KILL sent, the pane never reported dead
    const result = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") }) as { ok: boolean; guidance?: string };
    expect(result.ok).toBe(false);
    expect(f.tmux.respawnPane).not.toHaveBeenCalled();
    expect(result.guidance).not.toContain("was not changed");
    expect(result.guidance).toContain("not seen to exit");
    expect(result.guidance).toContain("rig capture dev-impl@rt-rig");
    expect(result.guidance).toContain("rig seat launch dev-impl@rt-rig --fresh --stop");
  });

  it("the ledger step names the launcher's code, so a retiree failure and a respawn failure differ (code and step only)", async () => {
    const failureOf = async (arrange: (f: ReturnType<typeof fixture>) => void) => {
      const f = fixture();
      arrange(f);
      const result = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
        runtimeChange: f.change("claude-code", "claude-opus-5-5") });
      expect(result.ok).toBe(false);
      return (f.db.prepare("SELECT failure FROM node_runtime_changes WHERE node_id = ?").get(f.node.id) as { failure: string }).failure;
    };
    const retiree = await failureOf((f) => { f.tmux.isPaneDead.mockResolvedValue(false); });
    const respawn = await failureOf((f) => { f.tmux.respawnPane.mockResolvedValue({ ok: false, code: "respawn_failed", message: "tmux said no" }); });
    expect(retiree).toBe("successor_create_failed at create-successor:create_successor:retiree_not_terminated");
    expect(respawn).toBe("successor_create_failed at create-successor:create_successor:respawn_failed");
  });

  it("a throw after the respawn is still recorded as failed: code and step, never the error", async () => {
    const f = fixture({ authoredRecapResolver: () => { throw new Error("recap store down SENTINEL-7c1e"); } });
    await expect(f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") })).rejects.toThrow("SENTINEL-7c1e");
    expect(f.tmux.respawnPane).toHaveBeenCalled();
    const rows = f.db.prepare("SELECT outcome, failure FROM node_runtime_changes WHERE node_id = ?").all(f.node.id);
    expect(rows).toEqual([{ outcome: "failed", failure: "threw_after_respawn at deliver-context" }]);
  });

  it("an oracle failure after the commit landed reports the commit, unwinds nothing and writes no failed row", async () => {
    const f = fixture({ activityOracle: { declareOccupantSwap: () => { throw new Error("oracle down"); } } });
    const result = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") }) as { ok: boolean; code?: string; message?: string; guidance?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("handover_committed_swap_undeclared");
    expect(result.message).toContain("committed");
    expect(result.guidance).not.toContain("--fresh --stop");
    expect(result.guidance).toContain("The runtime change is COMMITTED: the seat runs claude-code");
    expect(result.guidance).toContain("Do NOT retry, relaunch or revert to recover.");
    expect(result.guidance).toContain("Finish the declaration with: rig seat runtime-declare dev-impl@rt-rig");
    expect(result.guidance).not.toContain("report this");
    expect(f.ledger()).toEqual([{ kind: "change", outcome: "committed" }]);
    // The committed successor is untouched and is the seat's occupant on the target runtime.
    expect(f.db.prepare("SELECT status FROM discovered_sessions").all()).toEqual([{ status: "claimed" }]);
    expect(f.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "claude-code" });
    const live = f.db.prepare("SELECT session_name FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited')").all(f.node.id);
    expect(live).toHaveLength(1);
  });

  it("a throw after the commit landed returns handover_committed_with_error and leaves exactly one committed row (review r2 L1)", async () => {
    const f = fixture();
    const notify = f.eventBus.notifySubscribers.bind(f.eventBus);
    // seat.handover_completed is persisted inside the commit transaction and notified only after tx() returns.
    vi.spyOn(f.eventBus, "notifySubscribers").mockImplementation((event) => {
      if (event.type === "seat.handover_completed") throw new Error("subscriber down after the commit");
      notify(event);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await f.service.handover({ seatRef: "dev-impl@rt-rig", reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") }) as { ok: boolean; code?: string; message?: string; guidance?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("handover_committed_with_error");
    expect(result.message).toContain("subscriber down after the commit");
    expect(result.guidance).toContain("The runtime change is COMMITTED: the seat runs claude-code.");
    expect(result.guidance).toContain("Do NOT retry, relaunch or revert to recover.");
    expect(result.guidance).toContain("rig seat runtime-declare dev-impl@rt-rig");
    expect(logged).toHaveBeenCalled(); // the error is still logged, as the route's error handler logged it before
    logged.mockRestore();
    expect(f.ledger()).toEqual([{ kind: "change", outcome: "committed" }]);
    expect(f.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "claude-code" });
  });
});

describe("spec 0005: post-commit recovery (runtime-declare, committed-with-error)", () => {
  const SEAT = "dev-impl@rt-rig";
  const liveSessionId = (f: ReturnType<typeof fixture>) =>
    (f.db.prepare("SELECT id FROM sessions WHERE node_id = ? AND status NOT IN ('superseded', 'detached', 'exited')").all(f.node.id) as Array<{ id: string }>)
      .map((r) => r.id);
  const marker = (f: ReturnType<typeof fixture>) =>
    f.db.prepare("SELECT outcome, declared_at, declared_by FROM node_runtime_changes WHERE node_id = ? ORDER BY created_at, rowid").all(f.node.id) as
      Array<{ outcome: string; declared_at: string | null; declared_by: string | null }>;
  const undeclared = async () => {
    const oracle = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null } as never, defaultWindowSeconds: 3 });
    const f = fixture({ activityOracle: oracle });
    oracle.declareRungInventory({ seatNodeId: f.node.id, sessionName: SEAT }, runtimeRungInventory(null)); // the seat is in the ladder
    const swap = vi.spyOn(oracle, "declareOccupantSwap").mockImplementationOnce(() => { throw new Error("oracle down"); });
    const result = await f.service.handover({ seatRef: SEAT, reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") }) as { ok: boolean; code?: string };
    expect(result.code).toBe("handover_committed_swap_undeclared");
    return { f, oracle, swap };
  };

  it("a committed change whose declaration succeeds is marked declared at commit, by its operator", async () => {
    const f = fixture();
    expect((await f.service.handover({ seatRef: SEAT, reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") })).ok).toBe(true);
    const rows = marker(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("committed");
    expect(rows[0]!.declared_at).not.toBeNull();
    expect(rows[0]!.declared_by).toBe("operator-agent@kernel");
  });

  it("an undeclared committed change is re-declared: the activity read shows the new occupant, the ledger records who and when", async () => {
    const { f, oracle, swap } = await undeclared();
    expect(marker(f)).toEqual([{ outcome: "committed", declared_at: null, declared_by: null }]);
    const before = oracle.getSeatState(f.node.id)!;
    expect(before.lastSwap).toBeNull();

    const declared = await f.service.declareRuntimeOccupant({ seatRef: SEAT, caller: OPERATOR });
    expect(declared.ok).toBe(true);
    const live = liveSessionId(f);
    expect(live).toHaveLength(1);
    expect(swap).toHaveBeenLastCalledWith(f.node.id, live[0]);
    const after = oracle.getSeatState(f.node.id)!;
    expect(after.lastSwap?.generation).toBe(live[0]);
    expect(after.seq).toBeGreaterThan(before.seq);
    const [row] = marker(f);
    expect(row!.declared_at).not.toBeNull();
    expect(row!.declared_by).toBe("operator-agent@kernel");
    // identity: the committed successor is still the seat's occupant on the target runtime; nothing was relaunched
    expect(f.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "claude-code" });
    expect(f.tmux.respawnPane).toHaveBeenCalledTimes(1);
  });

  it("a declared change is refused, without calling the oracle again", async () => {
    const { f, swap } = await undeclared();
    expect((await f.service.declareRuntimeOccupant({ seatRef: SEAT, caller: OPERATOR })).ok).toBe(true);
    const calls = swap.mock.calls.length;
    const again = await f.service.declareRuntimeOccupant({ seatRef: SEAT, caller: OPERATOR }) as { ok: boolean; code?: string; message?: string };
    expect(again.ok).toBe(false);
    expect(again.code).toBe("runtime_declare_not_pending");
    expect(again.message).toContain("already declared");
    expect(swap.mock.calls.length).toBe(calls);
  });

  it("a seat with no committed runtime change, or one a later handover replaced, is refused", async () => {
    const none = fixture();
    const nothing = await none.service.declareRuntimeOccupant({ seatRef: SEAT, caller: OPERATOR }) as { ok: boolean; code?: string };
    expect(nothing.code).toBe("runtime_declare_not_pending");

    const { f, swap } = await undeclared();
    expect((await f.service.handover({ seatRef: SEAT, reason: "later", source: "fresh", caller: OPERATOR })).ok).toBe(true);
    const calls = swap.mock.calls.length;
    const superseded = await f.service.declareRuntimeOccupant({ seatRef: SEAT, caller: OPERATOR }) as { ok: boolean; code?: string; message?: string };
    expect(superseded.code).toBe("runtime_declare_not_pending");
    expect(superseded.message).toContain("later handover");
    expect(swap.mock.calls.length).toBe(calls);
    expect(marker(f)[0]!.declared_at).toBeNull();
  });

  it("only the kernel operator's transport identity may re-declare: no caller, the advisor and a relayed operator are refused", async () => {
    const { f, swap } = await undeclared();
    const calls = swap.mock.calls.length;
    for (const caller of [null, ADVISOR, { session: "operator-agent@kernel", provenance: "relay:v1" }]) {
      const refused = await f.service.declareRuntimeOccupant({ seatRef: SEAT, caller }) as { ok: boolean; code?: string };
      expect(refused.code).toBe("runtime_change_unauthorized");
    }
    expect(swap.mock.calls.length).toBe(calls);
    expect(marker(f)[0]!.declared_at).toBeNull();
  });

  it("a returned failure before the commit, followed by a throw, is never reported as committed", async () => {
    const f = fixture({ guard: true });
    const guard = (f.tmux as unknown as { deliveryGuard: SeatDeliveryGuard }).deliveryGuard;
    const lifecycle = guard.lifecycle.bind(guard);
    vi.spyOn(guard, "lifecycle").mockImplementation(async (ids, fn) => { await lifecycle(ids, fn); throw new Error("lease release failed"); });
    f.tmux.listPanes.mockResolvedValue([]); // resolve_pane fails before the respawn: a returned failure, recorded
    await expect(f.service.handover({ seatRef: SEAT, reason: "r", source: "fresh", caller: OPERATOR,
      runtimeChange: f.change("claude-code", "claude-opus-5-5") })).rejects.toThrow("lease release failed");
    expect(f.ledger()).toEqual([{ kind: "change", outcome: "failed" }]);
  });
});
