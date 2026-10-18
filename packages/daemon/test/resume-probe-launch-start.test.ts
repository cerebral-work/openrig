// cw.4.3 fix-forward (F-4b): the resume-metadata probe judges its pane by pane_current_command. A shell in the
// foreground before anything else was seen there means the launch has not started yet (in allow-list mode the
// scrub runs first), not that it returned to the shell. A shell after the launch was seen still fails the probe.
import { describe, it, expect } from "vitest";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";

function probeWith(paneCommands: string[], paneContent = "$ claude --resume tok") {
  const queue = ["bash", ...paneCommands]; // the first read is the probe's shell-ready check
  const tmuxAdapter = {
    createSession: async () => ({ ok: true }),
    sendLaunchCommand: async () => ({ ok: true }),
    getPaneCommand: async () => (queue.length > 1 ? queue.shift()! : queue[0]!),
    capturePaneContent: async () => paneContent,
    killSession: async () => {},
  };
  const refresher = new ResumeMetadataRefresher({ sessionRegistry: {} as never, tmuxAdapter: tmuxAdapter as never, sleep: async () => {}, homeDir: "/tmp" });
  return (refresher as unknown as { defaultProbeClaudeResume(name: string, token: string, cwd: string): Promise<string> })
    .defaultProbeClaudeResume("dev@rig", "tok", "/tmp");
}

describe("resume probe: a shell before the launch started is not a return to the shell", () => {
  it("a shell while the launch starts, then Claude in the foreground: resumable", async () => {
    expect(await probeWith(["bash", "bash", "claude"])).toBe("resumable");
  });

  it("a shell after the runtime was seen in the foreground: not resumable", async () => {
    expect(await probeWith(["node", "bash"])).toBe("not_resumable");
  });

  it("a shell that never leaves the foreground: inconclusive, not a verdict on the token", async () => {
    expect(await probeWith(["bash"])).toBe("inconclusive");
  });

  // Review r2 L1, lead ruling: only the runtime counts as started (claude, or node for an npm install, as the claim
  // service expects for claude-code), never the scrub's own helpers. A token the probe never tested is never "not resumable".
  it("the scrub's awk in the foreground is not the launch starting: a shell after it is inconclusive", async () => {
    expect(await probeWith(["bash", "awk", "bash"])).toBe("inconclusive");
    expect(await probeWith(["bash", "rm", "bash"])).toBe("inconclusive");
  });

  it("control: the scrub's awk, then Claude, is resumable", async () => {
    expect(await probeWith(["bash", "awk", "claude"])).toBe("resumable");
  });

  it("a scrub refusal visible in the pane is inconclusive, never not resumable", async () => {
    const refused = "$ ( . /tmp/openrig-send.sh )\nopenrig: seat_env_refused (step: re-list the environment; names: EXAMPLE_TOKEN); the command was not run\n$ ";
    expect(await probeWith(["bash", "awk", "bash"], refused)).toBe("inconclusive");
    expect(await probeWith(["node", "bash"], refused)).toBe("inconclusive");
  });

  // Review r2 L2 on #23: only the scrub's own refusal line counts, and only while Claude isn't the foreground process,
  // so a live Claude whose visible history mentions the refusal is still judged on its own state.
  it("a resumed Claude whose history mentions the refusal is resumable, even at a line start", async () => {
    const quoted = "> why did the launch print openrig: seat_env_refused (step: re-list the environment)?\n";
    const atLineStart = "openrig: seat_env_refused (step: re-list the environment; names: X); the command was not run\n";
    expect(await probeWith(["bash", "claude"], quoted)).toBe("resumable");
    // The probe pane is a fresh session: Claude's history is on screen only while Claude is the foreground process.
    expect(await probeWith(["claude"], atLineStart)).toBe("resumable");
    // An npm-installed Claude runs as node and isn't judged resumed by its name: the line in its history is still no refusal.
    expect(await probeWith(["node", "claude"], atLineStart)).toBe("resumable");
  });

  it("the string anywhere but at a line start is no refusal: Claude ran and the pane returned to a shell", async () => {
    expect(await probeWith(["node", "bash"], "$ grep seat_env_refused notes.txt\n$ ")).toBe("not_resumable");
  });
});
