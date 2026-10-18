import { describe, it, expect, afterEach } from "vitest";
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
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// Spec 0005: every refusal of a runtime change happens before anything changes, and the dry run changes nothing.
// The tmux adapter throws on any use, so a refusal or a dry run that touched a pane fails the test.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function adapter(runtime: string): RuntimeAdapter {
  const unused = async () => { throw new Error(`${runtime} adapter used`); };
  return { runtime, listInstalled: async () => [], project: unused, deliverStartup: unused, launchHarness: unused, checkReady: unused } as never;
}

function fixture(opts: { rigName?: string; memberRuntime?: string; memberModel?: string | null; envAllowlist?: string[] } = {}) {
  const rigName = opts.rigName ?? "rt-rig";
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rtc-unit-")));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "cwd");
  for (const d of [nodePath.join(rigRoot, "agents", "impl"), cwd]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  const memberModel = opts.memberModel === undefined ? "claude-opus-5-5" : opts.memberModel;
  const specYaml = [
    `version: "0.2"`, `name: ${rigName}`, `pods:`, `  - id: ${rigName === "kernel" ? "operator" : "dev"}`, `    label: Pod`, `    members:`,
    `      - id: ${rigName === "kernel" ? "agent" : "impl"}`,
    `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: ${opts.memberRuntime ?? "claude-code"}`,
    ...(memberModel ? [`        model: ${memberModel}`] : []), `        cwd: "${cwd}"`, `    edges: []`, `edges: []`,
  ].join("\n") + "\n";
  const specPath = nodePath.join(rigRoot, "rig.yaml");
  fs.writeFileSync(specPath, specYaml);

  const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const kernel = rigName === "kernel" ? rigRepo.createRig("kernel") : (() => {
    const k = rigRepo.createRig("kernel");
    rigRepo.addNode(k.id, "operator.agent", { runtime: "codex", cwd: root });
    rigRepo.addNode(k.id, "advisor.lead", { runtime: "claude-code", cwd: root });
    return k;
  })();
  const rig = rigName === "kernel" ? kernel : rigRepo.createRig(rigName);
  if (rigName === "kernel") rigRepo.addNode(kernel.id, "advisor.lead", { runtime: "claude-code", cwd: root });
  const node = rigRepo.addNode(rig.id, rigName === "kernel" ? "operator.agent" : "dev.impl", { runtime: "codex", cwd, model: "gpt-5.5-codex" });
  const seat = rigName === "kernel" ? "operator-agent@kernel" : `dev-impl@${rigName}`;
  const session = sessionRegistry.registerSession(node.id, seat);
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateBinding(node.id, { tmuxSession: seat, tmuxPane: "%1" });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'codex')").run(node.id);

  const adapters = { codex: adapter("codex"), "claude-code": adapter("claude-code") };
  const tmuxAdapter = new Proxy({}, { get: (_t, prop) => { if (prop === "deliveryGuard") return undefined; throw new Error(`tmux used: ${String(prop)}`); } });
  const memberStartup = new PodRigInstantiator({
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmuxAdapter as never }),
    startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmuxAdapter as never }),
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) }, tmuxAdapter, adapters,
  } as never);
  const service = new SeatHandoverService({
    db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, tmuxAdapter: tmuxAdapter as never,
    runtimeAdapters: adapters, memberStartup,
    ...(opts.envAllowlist ? { runtimeChangeEnvAllowlist: () => opts.envAllowlist! } : {}),
  });
  const unchanged = () => {
    expect(db.prepare("SELECT runtime, model FROM nodes WHERE id = ?").get(node.id)).toEqual({ runtime: "codex", model: "gpt-5.5-codex" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_runtime_changes WHERE outcome = 'committed'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT runtime FROM node_startup_context WHERE node_id = ?").get(node.id)).toEqual({ runtime: "codex" });
  };
  const request = (overrides: Partial<RuntimeChangeRequest> = {}): RuntimeChangeRequest => ({
    toRuntime: "claude-code", toModel: "claude-opus-5-5", toPermissions: "full_bypass",
    spec: { path: specPath, yaml: specYaml }, approval: "christian-go", ...overrides,
  });
  return { db, node, seat, cwd, service, unchanged, request, rigRepo };
}

const OPERATOR = { session: "operator-agent@kernel", provenance: "transport:v1" };
const ADVISOR = { session: "advisor-lead@kernel", provenance: "transport:v1" };

describe("spec 0005: runtime-change refusals and dry run", () => {
  it("D3: only the kernel operator, by transport identity, may change a runtime; the advisor is refused a forward change", async () => {
    const f = fixture();
    for (const caller of [null, { session: "dev-impl@rt-rig", provenance: "transport:v1" }, { ...OPERATOR, provenance: "claimed:v1" }, ADVISOR]) {
      const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", operator: "operator-agent@kernel", caller, runtimeChange: f.request() });
      expect(result).toMatchObject({ ok: false, code: "runtime_change_unauthorized" });
    }
    f.unchanged();
  });

  it("D3: an operator.agent seat in a rig not named kernel is not the kernel operator", async () => {
    const f = fixture();
    const impostor = f.rigRepo.createRig("impostor");
    f.rigRepo.addNode(impostor.id, "operator.agent", { runtime: "codex", cwd: f.cwd });
    for (const session of ["operator-agent@impostor"]) {
      const change = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", caller: { session, provenance: "transport:v1" }, runtimeChange: f.request() });
      expect(change).toMatchObject({ ok: false, code: "runtime_change_unauthorized" });
      const revert = await f.service.revertRuntimeChange({ seatRef: f.seat, reason: "r", approval: "go", caller: { session, provenance: "transport:v1" } });
      expect(revert).toMatchObject({ ok: false, code: "runtime_change_unauthorized" });
    }
    f.unchanged();
  });

  it("refuses before any change: no approval, no model, no explicit permissions, a fork source, an unchanged runtime", async () => {
    const f = fixture();
    const cases: Array<[Partial<RuntimeChangeRequest>, string]> = [
      [{ approval: null }, "runtime_change_invalid"],
      [{ toModel: null }, "runtime_change_invalid"],
      [{ toPermissions: null }, "runtime_change_invalid"],
      [{ toPermissions: "acceptEdits" }, "runtime_change_invalid"],
      [{ toRuntime: "codex" }, "runtime_change_invalid"],
    ];
    for (const [overrides, code] of cases) {
      const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: f.request(overrides) });
      expect(result, JSON.stringify(overrides)).toMatchObject({ ok: false, code });
    }
    const fork = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fork:abc", caller: OPERATOR, runtimeChange: f.request() });
    expect(fork).toMatchObject({ ok: false, code: "runtime_change_invalid" });
    f.unchanged();
  });

  it("refuses a secret-named --to-env before any change, even when the allow-list names it", async () => {
    const f = fixture({ envAllowlist: ["ANTHROPIC_API_KEY", "GH_TOKEN", "DB_PASSWORD", "MY_SECRET", "AWS_CREDS", "SSH_PRIVATE", "GPG_PASSPHRASE"] });
    for (const name of ["ANTHROPIC_API_KEY", "GH_TOKEN", "DB_PASSWORD", "MY_SECRET", "AWS_CREDS", "SSH_PRIVATE", "GPG_PASSPHRASE"]) {
      const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: f.request({ toEnv: [`${name}=x`] }) });
      expect(result, name).toMatchObject({ ok: false, code: "runtime_change_secret_env" });
    }
    f.unchanged();
  });

  it("--to-env takes only allow-listed names: the loader and shell variables are refused before any change", async () => {
    const f = fixture({ rigName: "kernel", memberModel: null });
    for (const name of ["LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS", "PATH", "BASH_ENV"]) {
      const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request({ toEnv: [`${name}=/tmp/x`] }) });
      expect(result, name).toMatchObject({ ok: false, code: "runtime_change_env_not_allowed" });
    }
    for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request({ toEnv: [`${name}=/tmp/x`] }) });
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
    }
    f.unchanged();
  });

  it("the --to-env allow-list is the configured one", async () => {
    const f = fixture({ rigName: "kernel", memberModel: null, envAllowlist: ["MY_TOOL_HOME"] });
    const allowed = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request({ toEnv: ["MY_TOOL_HOME=/x"] }) });
    expect(allowed.ok, JSON.stringify(allowed)).toBe(true);
    const refused = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request({ toEnv: ["CLAUDE_CONFIG_DIR=/x"] }) });
    expect(refused).toMatchObject({ ok: false, code: "runtime_change_env_not_allowed" });
  });

  it("D2: a non-kernel spec must declare the target runtime and model", async () => {
    for (const fx of [fixture({ memberRuntime: "codex" }), fixture({ memberModel: "claude-sonnet-5-5" }), fixture({ memberModel: null })]) {
      const result = await fx.service.handover({ seatRef: fx.seat, reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: fx.request() });
      expect(result).toMatchObject({ ok: false, code: "runtime_change_spec_mismatch" });
      fx.unchanged();
    }
    const missing = fixture();
    const noSpec = await missing.service.handover({ seatRef: missing.seat, reason: "r", source: "fresh", caller: OPERATOR, runtimeChange: missing.request({ spec: null }) });
    expect(noSpec).toMatchObject({ ok: false, code: "runtime_change_invalid" });
  });

  it("D2 on the kernel rig: the packaged variant need declare only the runtime; the dry run changes nothing", async () => {
    const f = fixture({ rigName: "kernel", memberModel: null });
    const result = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request() });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((result as { plan: { runtimeChange: unknown } }).plan.runtimeChange).toMatchObject({
      kind: "change", from: { runtime: "codex" }, to: { runtime: "claude-code", model: "claude-opus-5-5", permission: "full_bypass" }, approval: "christian-go",
    });
    f.unchanged();
  });

  it("D4: the dry run shows what inherit resolves to on the target runtime; full_bypass is accepted", async () => {
    const f = fixture();
    const inherit = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request({ toPermissions: "inherit" }) });
    expect((inherit as { plan: { runtimeChange: { inheritResolvesTo?: unknown; to: { permission: unknown } } } }).plan.runtimeChange)
      .toMatchObject({ to: { permission: null }, inheritResolvesTo: expect.any(Object) });
    const bypass = await f.service.handover({ seatRef: f.seat, reason: "r", source: "fresh", dryRun: true, caller: OPERATOR, runtimeChange: f.request() });
    expect(bypass.ok).toBe(true);
    f.unchanged();
  });

  it("a revert with no recorded change is refused, for the operator and the advisor alike", async () => {
    const f = fixture();
    for (const caller of [OPERATOR, ADVISOR]) {
      const result = await f.service.revertRuntimeChange({ seatRef: f.seat, reason: "r", approval: "go", caller });
      expect(result).toMatchObject({ ok: false, code: "runtime_revert_unavailable" });
    }
    const outsider = await f.service.revertRuntimeChange({ seatRef: f.seat, reason: "r", approval: "go", caller: { session: "dev-impl@rt-rig", provenance: "transport:v1" } });
    expect(outsider).toMatchObject({ ok: false, code: "runtime_change_unauthorized" });
    f.unchanged();
  });
});
