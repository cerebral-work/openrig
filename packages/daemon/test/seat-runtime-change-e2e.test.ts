import { describe, it, expect, afterAll, afterEach } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";
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

// Spec 0005: a runtime change hands a Codex seat to a Claude Code successor in the same pane, on an ISOLATED tmux
// server (a per-run -L socket on every command, teardown by session name, never kill-server). The two harnesses
// are stand-in adapters that type a stand-in command into the pane: this proves OpenRig's own plumbing (the same
// pane and name, the target's startup before the launch, the cwd and env the successor gets, the commit), not
// how the real Claude Code or Codex behave.

const pexec = promisify(execFile);
const SOCK = `openrig-rtc-${process.pid}`;
const cleanEnv: Record<string, string | undefined> = { ...process.env };
delete cleanEnv["TMUX"];
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const exec = async (cmd: string): Promise<string> => {
  const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
  const { stdout } = await pexec("sh", ["-c", safe], { env: cleanEnv as NodeJS.ProcessEnv });
  return stdout;
};
const tmux = (a: string) => exec(`tmux ${a}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function tmuxAvailableSync(): boolean {
  try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv as NodeJS.ProcessEnv, stdio: "ignore" }); return true; } catch { return false; }
}

const seats: string[] = [];
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const s of seats) await tmux(`kill-session -t ${q(s)}`).catch(() => {});
});
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A stand-in harness: its project() writes a marker into the cwd's runtime dir, and its launch types a command
 *  that prints the successor's cwd and CLAUDE_CONFIG_DIR, then stays in the foreground. */
function standIn(runtime: string, marker: string, opts: { ready?: boolean } = {}) {
  const calls = { projectedBeforeLaunch: null as boolean | null, postLaunchFiles: 0, resumeToken: null as string | null };
  const dir = runtime === "claude-code" ? ".claude" : ".agents";
  const adapter: RuntimeAdapter = {
    runtime,
    listInstalled: async () => [],
    async project(_plan, binding) {
      fs.mkdirSync(nodePath.join(binding.cwd, dir), { recursive: true });
      fs.writeFileSync(nodePath.join(binding.cwd, dir, "projected-by-standin"), runtime);
      return { projected: [], skipped: [], failed: [] };
    },
    async deliverStartup(files) {
      if (files.some((f) => f.deliveryHint === "send_text")) calls.postLaunchFiles++;
      return { delivered: files.length, failed: [] };
    },
    async launchHarness(binding, launchOpts) {
      calls.resumeToken = launchOpts.resumeToken ?? null;
      calls.projectedBeforeLaunch = fs.existsSync(nodePath.join(binding.cwd, dir, "projected-by-standin"));
      const command = `printf '${marker} cwd=%s cfg=%s\\n' "$PWD" "$CLAUDE_CONFIG_DIR"; exec sleep 600`;
      await tmux(`send-keys -t ${q(binding.tmuxPane ?? binding.tmuxSession!)} -l -- ${q(command)}`);
      await tmux(`send-keys -t ${q(binding.tmuxPane ?? binding.tmuxSession!)} Enter`);
      await sleep(150);
      return { ok: true, resumeToken: `${runtime}-token`, resumeType: runtime === "codex" ? "codex_id" : "claude_id" };
    },
    async checkReady(binding) {
      if (opts.ready === false) return { ready: false, reason: "stand-in never becomes ready" };
      const screen = await tmux(`capture-pane -p -t ${q(binding.tmuxPane ?? binding.tmuxSession!)}`);
      return screen.includes(marker) ? { ready: true } : { ready: false, reason: "not drawn yet" };
    },
  };
  return { adapter, calls };
}

async function fixture(opts: { claudeReady?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-rtc-")));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const oldCwd = nodePath.join(root, "codex-cwd");
  const newCwd = nodePath.join(root, "claude-cwd");
  const configDir = nodePath.join(root, "claude-config");
  for (const d of [nodePath.join(rigRoot, "agents", "impl"), oldCwd, newCwd, configDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  // The predecessor runtime's leftovers, which a runtime change leaves in place.
  fs.writeFileSync(nodePath.join(oldCwd, "AGENTS.md"), "codex guidance\n");
  const specPath = nodePath.join(rigRoot, "rig.yaml");
  const specYaml = [
    `version: "0.2"`,
    `name: rt-rig`,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        model: claude-opus-5-5`,
    `        cwd: "${newCwd}"`,
    `        env:`,
    `          CLAUDE_CONFIG_DIR: "${configDir}"`,
    `    edges: []`,
    `edges: []`,
  ].join("\n") + "\n";
  fs.writeFileSync(specPath, specYaml);

  const SEAT = `dev-impl@rt-rig`;
  seats.push(SEAT);
  await tmux(`kill-session -t ${q(SEAT)}`).catch(() => {});
  await tmux(`new-session -d -s ${q(SEAT)} -c ${q(oldCwd)} -x 140 -y 30`);
  await sleep(200);
  const pane = (await tmux(`list-panes -t ${q(SEAT)} -F '#{pane_id}'`)).trim();
  await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM; echo codex-predecessor-line")}`);
  await tmux(`send-keys -t ${q(pane)} Enter`);
  await sleep(200);

  const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
  const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
  const rig = rigRepo.createRig("rt-rig");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: oldCwd, model: "gpt-5.5-codex" });
  const session = sessionRegistry.registerSession(node.id, SEAT);
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateStartupStatus(session.id, "ready", new Date("2026-10-18T05:00:00Z").toISOString());
  sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: pane });
  db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'codex')")
    .run(node.id);
  const kernel = rigRepo.createRig("kernel");
  rigRepo.addNode(kernel.id, "operator.agent", { runtime: "codex", cwd: root });
  rigRepo.addNode(kernel.id, "advisor.lead", { runtime: "claude-code", cwd: root });

  const codex = standIn("codex", "STANDIN-CODEX");
  const claude = standIn("claude-code", "STANDIN-CLAUDE", { ready: opts.claudeReady });
  const tmuxAdapter = new TmuxAdapter(exec);
  const resolverFs = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
  const memberStartup = new PodRigInstantiator({
    db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus,
    nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter }),
    startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter }),
    fsOps: resolverFs, tmuxAdapter,
    adapters: { codex: codex.adapter, "claude-code": claude.adapter },
  } as never);
  const service = new SeatHandoverService({
    db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
    tmuxAdapter, runtimeAdapters: { codex: codex.adapter, "claude-code": claude.adapter },
    memberStartup,
    predecessorRecapResolver: () => ({ unavailableReason: "e2e stand-in has no record" }),
    readinessTimeoutMs: 2500, sleep,
  });
  return { db, SEAT, pane, node, session, oldCwd, newCwd, configDir, specPath, specYaml, service, claude, codex };
}

const OPERATOR = { session: "operator-agent@kernel", provenance: "transport:v1" as const };
const ADVISOR = { session: "advisor-lead@kernel", provenance: "transport:v1" as const };

async function changeToClaude(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.service.handover({
    seatRef: f.SEAT, reason: "e2e runtime change", source: "fresh", caller: OPERATOR,
    runtimeChange: {
      toRuntime: "claude-code", toModel: "claude-opus-5-5", toPermissions: "full_bypass",
      toCwd: f.newCwd, toEnv: [`CLAUDE_CONFIG_DIR=${f.configDir}`],
      spec: { path: f.specPath, yaml: f.specYaml }, approval: "christian-go-e2e",
    },
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

describe("spec 0005: cross-runtime seat handover (isolated tmux)", () => {
  it.runIf(tmuxAvailableSync())(
    "codex to claude-code: the same pane and name; the node, tenure, startup context and ledger record the change; the successor gets its cwd and CLAUDE_CONFIG_DIR",
    async () => {
      const f = await fixture();
      const sessions = await tmux("list-sessions -F '#{session_name}'");
      expect(sessions).not.toMatch(/@kernel|orch-|review-/); // isolation first

      const result = await f.service.handover({
        seatRef: f.SEAT, reason: "e2e runtime change", source: "fresh", caller: OPERATOR,
        runtimeChange: {
          toRuntime: "claude-code", toModel: "claude-opus-5-5", toPermissions: "full_bypass",
          toCwd: f.newCwd, toEnv: [`CLAUDE_CONFIG_DIR=${f.configDir}`],
          spec: { path: f.specPath, yaml: f.specYaml }, approval: "christian-go-e2e",
        },
      } as never) as { ok: boolean; result?: { currentOccupant: string; runtimeChange?: { leftovers: string[] } } };
      await sleep(300);

      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.result!.currentOccupant).toBe(f.SEAT);
      expect((await tmux(`list-panes -t ${q(f.SEAT)} -F '#{pane_id}'`)).trim()).toBe(f.pane);
      const screen = await tmux(`capture-pane -p -t ${q(f.pane)} -S -200`);
      expect(screen).toContain("codex-predecessor-line");
      expect(screen).toContain(`STANDIN-CLAUDE cwd=${f.newCwd} cfg=${f.configDir}`);
      expect(f.claude.calls.projectedBeforeLaunch, "the target's projection ran before the launch").toBe(true);

      const node = f.db.prepare("SELECT runtime, model, cwd, env_json FROM nodes WHERE id = ?").get(f.node.id) as Record<string, string>;
      expect(node).toMatchObject({ runtime: "claude-code", model: "claude-opus-5-5", cwd: f.newCwd });
      expect(JSON.parse(node["env_json"]!)).toEqual({ CLAUDE_CONFIG_DIR: f.configDir });
      const tenure = f.db.prepare("SELECT runtime FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1").get(f.node.id) as { runtime: string };
      expect(tenure.runtime).toBe("claude-code");
      const context = f.db.prepare("SELECT runtime FROM node_startup_context WHERE node_id = ?").get(f.node.id) as { runtime: string };
      expect(context.runtime).toBe("claude-code");
      const ledger = f.db.prepare("SELECT * FROM node_runtime_changes WHERE node_id = ?").all(f.node.id) as Array<Record<string, string>>;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ kind: "change", outcome: "committed", from_runtime: "codex", to_runtime: "claude-code",
        to_model: "claude-opus-5-5", to_cwd: f.newCwd, approval: "christian-go-e2e", operator: "operator-agent@kernel",
        acceptance: "pending", spec_sha256: sha256(f.specYaml) });
      expect(JSON.parse(ledger[0]!["to_env"]!)).toEqual([{ name: "CLAUDE_CONFIG_DIR", sha256: sha256(f.configDir) }]);
      expect(JSON.stringify(ledger[0])).not.toContain(f.configDir);
      expect(fs.readFileSync(nodePath.join(f.oldCwd, "AGENTS.md"), "utf-8"), "the old runtime's files are left").toBe("codex guidance\n");
      expect(result.result!.runtimeChange!.leftovers.join("\n")).toContain(f.oldCwd);
      f.db.close();
    },
    60_000,
  );

  it.runIf(tmuxAvailableSync())(
    "after a committed change whose successor is unusable, the advisor reverts it: codex again in the same pane with the old cwd, env and startup context; a second revert is refused",
    async () => {
      const f = await fixture();
      await changeToClaude(f);
      const reverted = await f.service.revertRuntimeChange({ seatRef: f.SEAT, reason: "claude successor unusable", approval: "christian-pre-recorded-go", caller: ADVISOR }) as
        { ok: boolean; result?: { runtimeChange?: { kind: string } } };
      await sleep(300);
      expect(reverted.ok, JSON.stringify(reverted)).toBe(true);
      expect(reverted.result!.runtimeChange!.kind).toBe("revert");
      expect((await tmux(`list-panes -t ${q(f.SEAT)} -F '#{pane_id}'`)).trim()).toBe(f.pane);
      expect(await tmux(`capture-pane -p -t ${q(f.pane)} -S -300`)).toContain(`STANDIN-CODEX cwd=${f.oldCwd} cfg=\n`);
      expect(f.codex.calls.resumeToken, "a fresh revert by default").toBeNull();
      const node = f.db.prepare("SELECT runtime, model, cwd, env_json FROM nodes WHERE id = ?").get(f.node.id);
      expect(node).toEqual({ runtime: "codex", model: "gpt-5.5-codex", cwd: f.oldCwd, env_json: null });
      expect(f.db.prepare("SELECT runtime, projection_entries_json FROM node_startup_context WHERE node_id = ?").get(f.node.id))
        .toEqual({ runtime: "codex", projection_entries_json: "[]" });
      const ledger = f.db.prepare("SELECT id, kind, outcome, reverts_change_id, operator FROM node_runtime_changes WHERE node_id = ? ORDER BY created_at").all(f.node.id) as Array<Record<string, string | null>>;
      expect(ledger.map((row) => [row["kind"], row["outcome"], row["operator"]])).toEqual([
        ["change", "committed", "operator-agent@kernel"], ["revert", "committed", "advisor-lead@kernel"]]);
      expect(ledger[1]!["reverts_change_id"]).toBe(ledger[0]!["id"]);
      expect(f.db.prepare("SELECT COUNT(*) AS n FROM node_runtime_revert_slots").get()).toEqual({ n: 0 });
      const again = await f.service.revertRuntimeChange({ seatRef: f.SEAT, reason: "again", approval: "go", caller: ADVISOR });
      expect(again).toMatchObject({ ok: false, code: "runtime_revert_unavailable" });
      f.db.close();
    },
    60_000,
  );

  it.runIf(tmuxAvailableSync())(
    "a revert with --resume-predecessor resumes the predecessor's recorded conversation under its own runtime",
    async () => {
      const f = await fixture();
      f.db.prepare("UPDATE sessions SET resume_token = 'codex-thread-before-the-change', resume_type = 'codex_id' WHERE id = ?").run(f.session.id);
      await changeToClaude(f);
      const reverted = await f.service.revertRuntimeChange({ seatRef: f.SEAT, reason: "back to the codex conversation", approval: "go", caller: OPERATOR, resumePredecessor: true });
      expect(reverted.ok, JSON.stringify(reverted)).toBe(true);
      expect(f.codex.calls.resumeToken).toBe("codex-thread-before-the-change");
      expect(f.db.prepare("SELECT runtime FROM nodes WHERE id = ?").get(f.node.id)).toEqual({ runtime: "codex" });
      f.db.close();
    },
    60_000,
  );

  it.runIf(tmuxAvailableSync())(
    "a successor that never becomes ready leaves the node, its startup context and the predecessor session as they were, and records a failed attempt",
    async () => {
      const f = await fixture({ claudeReady: false });
      const result = await f.service.handover({
        seatRef: f.SEAT, reason: "e2e failing runtime change", source: "fresh", caller: OPERATOR,
        runtimeChange: {
          toRuntime: "claude-code", toModel: "claude-opus-5-5", toPermissions: "full_bypass",
          toCwd: f.newCwd, toEnv: [`CLAUDE_CONFIG_DIR=${f.configDir}`],
          spec: { path: f.specPath, yaml: f.specYaml }, approval: "christian-go-e2e",
        },
      } as never) as { ok: boolean; code?: string };

      expect(result.ok).toBe(false);
      const node = f.db.prepare("SELECT runtime, model, cwd, env_json FROM nodes WHERE id = ?").get(f.node.id) as Record<string, string | null>;
      expect(node).toMatchObject({ runtime: "codex", model: "gpt-5.5-codex", cwd: f.oldCwd, env_json: null });
      const context = f.db.prepare("SELECT runtime FROM node_startup_context WHERE node_id = ?").get(f.node.id) as { runtime: string };
      expect(context.runtime, "a plain fresh relaunch still finds a codex startup context for a codex node").toBe("codex");
      const predecessor = f.db.prepare("SELECT status FROM sessions WHERE id = ?").get(f.session.id) as { status: string };
      expect(predecessor.status).not.toBe("superseded");
      const ledger = f.db.prepare("SELECT kind, outcome, to_runtime FROM node_runtime_changes WHERE node_id = ?").all(f.node.id);
      expect(ledger).toEqual([{ kind: "change", outcome: "failed", to_runtime: "claude-code" }]);
      f.db.close();
    },
    60_000,
  );
});
