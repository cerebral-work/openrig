import nodePath from "node:path";
import os from "node:os";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile, InstalledResource, ProjectionResult,
  StartupDeliveryResult, ReadinessResult, HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { observeAgyPermission } from "../domain/permission-drift.js";
import { classifyAgyScreen, prepareAgyLaunch, readAgyConversationId } from "../domain/agy-runtime.js";
import { agyPostureArg } from "./yolo-mode.js";
import { AgyResumeAdapter } from "./agy-resume.js";
import { shellQuote } from "./shell-quote.js";
import type { CodexAdapterFsOps } from "./codex-runtime-adapter.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export type AgyAdapterFsOps = CodexAdapterFsOps & {
  /** Used to drop a stale conversation-id sidecar before a fresh launch. Optional: skipped when absent. */
  remove?(path: string): void;
};

/**
 * Google Antigravity CLI (`agy`) runtime adapter: a tmux-native TUI seat, like Codex.
 *
 * Startup context: agy has no system-prompt flag. Like Codex, guidance is merged
 * into `<cwd>/AGENTS.md` (agy reads workspace AGENTS.md/GEMINI.md), skills go to
 * `<cwd>/.agents/skills/<name>/`, and `send_text` files are typed into the ready TUI.
 * `-i "<prompt>"` was rejected: launch happens before startup files are resolved,
 * and `-i` would start a turn before readiness is established.
 *
 * Resume token: agy creates no conversation until the first turn, so a fresh
 * launch returns no token. The id is captured later from the sidecar written by
 * OpenRig's PreInvocation hook (see readConversationId / resume-token-capture).
 */
export class AgyRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "agy";
  private tmux: TmuxAdapter;
  private fs: AgyAdapterFsOps;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private stateRoot: string;
  private homeDir: string;
  private hookScriptPath?: string;
  private resumeAdapter: AgyResumeAdapter;
  private sleep: (ms: number) => Promise<void>;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: AgyAdapterFsOps;
    seatLaunchEnvironment?: SeatLaunchEnvironment;
    /** `$OPENRIG_HOME/state/agy`: where the hook script writes <session>.json. */
    stateRoot: string;
    /** Parent of `.gemini`; defaults to the OS home. Tests pass a temp dir. */
    homeDir?: string;
    /** Absolute path of the packaged openrig-agy-hook.sh; absent disables hook registration. */
    hookScriptPath?: string;
    sleep?: (ms: number) => Promise<void>;
    pollMs?: number;
    maxWaitMs?: number;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.stateRoot = deps.stateRoot;
    this.homeDir = deps.homeDir ?? os.homedir();
    this.hookScriptPath = deps.hookScriptPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.resumeAdapter = new AgyResumeAdapter(deps.tmux, {
      seatLaunchEnvironment: deps.seatLaunchEnvironment,
      homeDir: this.homeDir,
      hookScriptPath: deps.hookScriptPath,
      sleep: deps.sleep,
      pollMs: deps.pollMs,
      maxWaitMs: deps.maxWaitMs,
    });
  }

  /** resume-token-capture's agyStateStore shape. */
  readConversationId(sessionName: string): { ok: true; conversationId: string } | { ok: false; reason: string } {
    return readAgyConversationId(this.stateRoot, sessionName);
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    if (!this.fs.exists(skillsDir) || !this.fs.listFiles) return [];
    return this.fs.listFiles(skillsDir).map((file) => ({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const warnings: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") { skipped.push(entry.effectiveId); continue; }
      try {
        (this.projectEntry(entry, binding.cwd, warnings) ? projected : skipped).push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }
    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  // Guidance (managed block) and skills are the only resource kinds agy reads from the workspace today.
  private projectEntry(entry: ProjectionEntry, cwd: string, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(nodePath.join(cwd, "AGENTS.md"), entry.effectiveId, this.fs.readFile(entry.absolutePath), warnings);
    }
    if (entry.category === "skill") {
      const targetDir = nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fs.readFile(entry.absolutePath));
      return true;
    }
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[]): boolean {
    // Same collision rule as Codex: per-seat role content goes through send_text, not a shared AGENTS.md block.
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.fs, targetPath, blockId, content, { warnings });
    return true;
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];
    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (!this.mergeGuidance(nodePath.join(binding.cwd, "AGENTS.md"), file.path, content, warnings)) continue;
        } else if (hint === "skill_install") {
          const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
          this.fs.mkdirp(targetDir);
          this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
        } else if (binding.tmuxSession) {
          const text = await this.tmux.sendText(binding.tmuxSession, content);
          if (!text.ok) throw new Error(text.message);
          await this.sleep(200);
          const submit = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
          if (!submit.ok) throw new Error(submit.message);
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound — cannot launch Agy harness" };
    if (opts.resumeToken && opts.forkSource) return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    if (opts.forkSource) return { ok: false, error: "agy fork is not supported (agy 1.4.0 exposes no fork flag)" };

    let posture: string;
    try { posture = agyPostureArg(binding.permissionMode); } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    if (opts.resumeToken) {
      const validation = validateResumeToken("agy", opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `agy resume: ${validation.error}` };
      const result = await this.resumeAdapter.resume(
        binding.tmuxSession, "agy_id", validation.token, binding.cwd, binding.permissionMode, binding.nodeId, binding.launchGeneration,
      );
      if (result.ok) return { ok: true, resumeToken: validation.token, resumeType: "agy_id", ...(result.appliedLaunch ? { appliedLaunch: result.appliedLaunch } : {}) };
      if (result.code === "retry_fresh") return { ok: false, error: result.message, recovery: "retry_fresh" };
      if (result.code === "attention_required") {
        return { ok: false, error: result.message, recovery: "attention_required", ...("evidence" in result && result.evidence ? { evidence: result.evidence } : {}) };
      }
      return { ok: false, error: result.message };
    }

    try {
      const { warnings } = prepareAgyLaunch({ cwd: binding.cwd, homeDir: this.homeDir, hookScriptPath: this.hookScriptPath });
      for (const w of warnings) console.error(`[openrig] ${w}`);
    } catch (err) {
      return { ok: false, error: `agy trust provisioning failed: ${(err as Error).message}` };
    }

    // A fresh conversation must not inherit the previous occupant's id: drop the old sidecar.
    this.removeStaleSidecar(binding.tmuxSession);

    const appliedLaunch = observeAgyPermission(posture);
    const cmd = `agy${posture}`;
    const wrapped = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(binding.tmuxSession, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: this.runtime })
      : cmd;
    const sent = await this.tmux.sendShellCommand(binding.tmuxSession, `cd ${shellQuote(binding.cwd)} && ${wrapped}`);
    if (!sent.ok) return { ok: false, error: `Failed to send launch command: ${sent.message}` };
    // No conversation exists until the first turn; the resume token is captured later from the hook sidecar.
    return { ok: true, appliedLaunch };
  }

  private removeStaleSidecar(session: string): void {
    if (!this.fs.remove || session.includes("/") || session.includes("..")) return;
    const path = nodePath.join(this.stateRoot, `${session}.json`);
    try { if (this.fs.exists(path)) this.fs.remove(path); } catch { /* best effort */ }
  }

  private async captureScreen(target: string): Promise<string> {
    if (this.tmux.capturePaneScreen) return (await this.tmux.capturePaneScreen(target)) ?? "";
    return (await this.tmux.capturePaneContent(target, 40)) ?? "";
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) return { ready: false, reason: "tmux session not responsive" };

    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    if (SHELL_COMMANDS.has(paneCommand)) {
      return { ready: false, reason: "Agy is not running in the pane (shell in the foreground)", code: "not_running" };
    }
    const state = classifyAgyScreen(await this.captureScreen(binding.tmuxSession));
    switch (state) {
      case "ready": return { ready: true };
      case "trust":
        return {
          ready: false, code: "trust_gate",
          reason: "Agy is waiting for workspace trust approval before the session can become interactive. OpenRig does not answer this dialog.",
        };
      case "working": return { ready: false, reason: "Agy is generating a response (not at the input prompt)" };
      default: return { ready: false, reason: "Agy screen not recognized as ready (no '? for shortcuts' footer)" };
    }
  }
}
