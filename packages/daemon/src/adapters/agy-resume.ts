import { setTimeout as sleep } from "node:timers/promises";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { ResumeResult } from "./claude-resume.js";
import { shellQuote } from "./shell-quote.js";
import { agyPostureArg } from "./yolo-mode.js";
import { observeAgyPermission } from "../domain/permission-drift.js";
import { classifyAgyScreen, prepareAgyLaunch, AGY_CONVERSATION_ID_RE } from "../domain/agy-runtime.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface AgyResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  /** agy's home (parent of .gemini); tests pass a temp dir, production the OS home. */
  homeDir?: string;
  hookScriptPath?: string;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The resume launch line: `agy --dangerously-skip-permissions [--mode m] --conversation <uuid>`. */
export function buildAgyResumeCommand(conversationId: string, permissionMode?: string | null): string {
  return `agy${agyPostureArg(permissionMode)} --conversation ${shellQuote(conversationId)}`;
}

/** Restores an agy conversation by id. Same shape as CodexResumeAdapter: launch, then verify from the pane. */
export class AgyResumeAdapter {
  constructor(private tmux: TmuxAdapter, private options: AgyResumeOptions = {}) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "agy_id" && !!resumeToken && AGY_CONVERSATION_ID_RE.test(resumeToken);
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    permissionMode?: string | null,
    nodeId?: string,
    generation?: string,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Agy resume not available" };
    }
    let posture: string;
    try { posture = agyPostureArg(permissionMode); } catch (err) {
      return { ok: false, code: "resume_failed", message: (err as Error).message };
    }
    try {
      const { warnings } = prepareAgyLaunch({ cwd, homeDir: this.options.homeDir, hookScriptPath: this.options.hookScriptPath });
      for (const w of warnings) console.error(`[openrig] ${w}`);
    } catch (err) {
      return { ok: false, code: "resume_failed", message: `agy trust provisioning failed: ${(err as Error).message}` };
    }
    const appliedLaunch = observeAgyPermission(posture);
    const cmd = buildAgyResumeCommand(resumeToken!, permissionMode);
    const wrapped = this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { nodeId, generation, runtime: "agy" })
      : cmd;
    const sent = await this.tmux.sendShellCommand(tmuxSessionName, `cd ${shellQuote(cwd)} && ${wrapped}`);
    if (!sent.ok) return { ok: false, code: "resume_failed", message: sent.message };
    const verified = await this.verifyResume(tmuxSessionName);
    return verified.ok ? { ...verified, appliedLaunch } : verified;
  }

  private async capture(target: string): Promise<string> {
    if (this.tmux.capturePaneScreen) return (await this.tmux.capturePaneScreen(target)) ?? "";
    return (await this.tmux.capturePaneContent(target, 40)) ?? "";
  }

  private async verifyResume(session: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 500;
    const maxWaitMs = this.options.maxWaitMs ?? 15_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);
    let content = "";
    let command: string | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      command = await this.tmux.getPaneCommand(session);
      content = await this.capture(session);
      const state = classifyAgyScreen(content);
      if (state === "trust") {
        return {
          ok: false, code: "attention_required",
          message: "Agy is waiting for workspace trust approval. OpenRig does not answer the trust dialog; an operator must confirm it.",
          evidence: content.split("\n").slice(-12).join("\n"),
        };
      }
      // A resumed conversation lands on the idle screen or goes straight back to work.
      if (state === "ready" || state === "working") return { ok: true };
      if (attempt < attempts - 1) await sleepFn(pollMs);
    }
    if (command && SHELL_COMMANDS.has(command)) {
      return { ok: false, code: "retry_fresh", message: "Agy resume failed: pane returned to shell instead of entering agy" };
    }
    return { ok: false, code: "resume_failed", message: "Agy resume failed: timed out waiting for agy to become active" };
  }
}
