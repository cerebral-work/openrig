import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// Review r2 F3: a failed respawn's error names its argv, and the argv carries every env value as -e NAME=VALUE. No
// value may reach the runtime-change ledger, an event or a log; the respawn's own error keeps the names only.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const TO_SENTINEL = "s3ntinel-to-env-9f2c";
const RIG_SENTINEL = "s3ntinel-rig-env-4b7a";

describe("review r2 F3: no env value in a failed respawn's trail", () => {
  it("TmuxAdapter.respawnPane redacts every env value from its error, on both exec paths, and keeps the names", async () => {
    const env = { DATABASE_URL: `postgres://app:${RIG_SENTINEL}@db/app`, QUOTED: `it's ${TO_SENTINEL}` };
    const legacy = new TmuxAdapter(async (command) => { throw new Error(`Command failed: ${command}\nno server running on /tmp/tmux-0/x`); });
    const argv = new TmuxAdapter(async () => "", undefined, async (args) => { throw new Error(`Command failed: ${args.join(" ")}\nno server running`); });
    for (const adapter of [legacy, argv]) {
      const result = await adapter.respawnPane("%1", "sh", { cwd: "/tmp", env });
      expect(result.ok).toBe(false);
      const message = (result as { message: string }).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain(RIG_SENTINEL);
      expect(message).not.toContain(TO_SENTINEL);
    }
  });

  it("a runtime change whose respawn fails records a code and step only: no value in the DB, events or logs", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rtc-secrets-")));
    tmpDirs.push(root);
    const rigRoot = nodePath.join(root, "rig");
    const cwd = nodePath.join(root, "cwd");
    for (const d of [nodePath.join(rigRoot, "agents", "impl"), cwd]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
      `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
    const kernel = rigRepo.createRig("kernel");
    rigRepo.addNode(kernel.id, "operator.agent", { runtime: "codex", cwd: root });
    const yaml = [`version: "0.2"`, `name: kernel`, `pods:`, `  - id: operator`, `    label: Operator`, `    members:`, `      - id: agent`,
      `        agent_ref: "local:agents/impl"`, `        profile: default`, `        runtime: claude-code`, `        cwd: "${cwd}"`,
      `    edges: []`, `edges: []`].join("\n") + "\n";
    const node = rigRepo.getRig(kernel.id)!.nodes.find((candidate) => candidate.logicalId === "operator.agent")!;
    rigRepo.setRigEnv(kernel.id, { DATABASE_URL: `postgres://app:${RIG_SENTINEL}@db/app` });
    const session = sessionRegistry.registerSession(node.id, "operator-agent@kernel");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "operator-agent@kernel", tmuxPane: "%0" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'codex')").run(node.id);

    const adapter = (runtime: string): RuntimeAdapter => ({
      runtime, listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async () => ({ ok: true }), checkReady: async () => ({ ready: true }),
    } as never);
    const adapters = { codex: adapter("codex"), "claude-code": adapter("claude-code") };
    // The respawn fails the way tmux's exec paths report it: with its full argv.
    const tmux = {
      hasSession: vi.fn(async () => true), listPanes: vi.fn(async () => [{ id: "%9", index: 0, cwd, width: 80, height: 24, active: true }]),
      setRemainOnExit: vi.fn(async () => ({ ok: true })), signalPaneProcess: vi.fn(async () => ({ ok: true })), isPaneDead: vi.fn(async () => true),
      capturePaneScreen: vi.fn(async () => "predecessor"), getDefaultShell: vi.fn(async () => "/bin/zsh"), getPaneCommand: vi.fn(async () => "zsh"),
      respawnPane: vi.fn(async (_pane: string, _command: string, opts: { env?: Record<string, string> }) => ({
        ok: false, code: "unknown",
        message: `Command failed: tmux respawn-pane -t '%9' ${Object.entries(opts.env ?? {}).map(([k, v]) => `-e '${k}=${v}'`).join(" ")}`,
      })),
    } as never;
    const memberStartup = new PodRigInstantiator({
      db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
      nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) }, tmuxAdapter: tmux, adapters,
    } as never);
    const service = new SeatHandoverService({
      db, rigRepo, sessionRegistry, discoveryRepo: new DiscoveryRepository(db), eventBus, tmuxAdapter: tmux,
      runtimeAdapters: adapters, memberStartup, readinessTimeoutMs: 50, sleep: async () => {},
    });
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    }
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { logged.push(String(chunk)); return true; }) as never);

    const result = await service.handover({
      seatRef: "operator-agent@kernel", reason: "secret probe", source: "fresh",
      caller: { session: "operator-agent@kernel", provenance: "transport:v1" },
      runtimeChange: { toRuntime: "claude-code", toModel: "claude-opus-5-5", toPermissions: "full_bypass",
        toEnv: [`CLAUDE_CONFIG_DIR=/cfg/${TO_SENTINEL}`], spec: { path: nodePath.join(rigRoot, "rig.yaml"), yaml }, approval: "go" },
    });
    expect(result.ok).toBe(false);
    const ledger = db.prepare("SELECT outcome, failure FROM node_runtime_changes").all() as Array<{ outcome: string; failure: string }>;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.outcome).toBe("failed");
    expect(ledger[0]!.failure).toMatch(/^successor_create_failed at /);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const table of tables) {
      const dump = JSON.stringify(db.prepare(`SELECT * FROM "${table}"`).all());
      expect(dump, table).not.toContain(TO_SENTINEL);
      if (table !== "rigs") expect(dump, table).not.toContain(RIG_SENTINEL); // rigs.env_json is where the rig env lives
    }
    expect(logged.join("\n")).not.toContain(TO_SENTINEL);
    expect(logged.join("\n")).not.toContain(RIG_SENTINEL);
  });
});
