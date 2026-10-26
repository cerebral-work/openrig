// The v0.7.2 merge (cw.1-rc.2) combined upstream's scoped launch (#1178) with the fork's allow-list restart
// (spec 0013). The scoped launch starts the pane through a private file that the pane removes as it starts, so
// restarting that pane re-ran the start command after the file was gone: the pane exited 2 and the session
// closed ("can't find session"). Seen live on 2026-10-26 for every seat launched on a running tmux server.
import { describe, it, expect } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { SEAT_ENV_DEFAULT_BASE, type SeatEnvPolicy } from "../src/domain/seat-launch-env-filter.js";

const POLICY: SeatEnvPolicy = { mode: "allowlist", base: SEAT_ENV_DEFAULT_BASE, exceptions: [], kubeconfig: "/scoped/k", rigs: [] };

function adapter(inheritTmuxEnvironment: boolean) {
  const execs: string[] = [];
  const launchFiles: string[] = [];
  const fileOps: TmuxFileOps = {
    writeFile: async (_p, content) => { if (content.startsWith("/bin/rm -f --")) launchFiles.push(content); },
    unlink: async () => {},
    tmpName: () => "/tmp/openrig-send.sh",
    bufferName: () => "openrig_1_buf",
  };
  const a = new TmuxAdapter(async (cmd) => {
    execs.push(cmd);
    if (cmd.includes("source-file")) return "%1\n"; // the private config that runs new-session prints its pane
    if (cmd.includes("default-shell")) return "/bin/bash\n";
    if (cmd.includes("update-environment")) return "DISPLAY\n";
    if (cmd.includes("default-command")) return "\n";
    const sub = cmd.split(" ")[1] ?? "";
    if (sub === "show-environment") return cmd.includes(" -g") ? "OP_SERVICE_ACCOUNT_TOKEN=x\nHOME=/h\n" : "OPENRIG_NODE_ID=n1\n-HOME\n";
    if (sub === "list-panes") return "%1|0|/w|80|24|1\n";
    if (sub === "display-message") return "bash\n";
    return "";
  }, fileOps);
  a.launchEnvironment = () => ({ inheritTmuxEnvironment, env: { LANG: "C.UTF-8" } });
  a.setSeatEnvPolicy(() => POLICY, () => false);
  return { a, execs, launchFiles };
}

describe("allow-list mode with the scoped launch", () => {
  it("a fresh seat started by the scoped launch is not restarted, so its launch file is read once", async () => {
    const { a, execs, launchFiles } = adapter(false);
    const result = await a.createSession("dev@rig", "/w", { OPENRIG_NODE_ID: "n1" });
    expect(result.ok).toBe(true);
    expect(launchFiles).toHaveLength(1); // control: the scoped launch ran
    expect(execs.some((cmd) => cmd.startsWith("tmux respawn-pane"))).toBe(false);
    // The allow-list still applies to the session environment, for later panes.
    expect(execs.some((cmd) => cmd.startsWith("tmux set-environment") || cmd.includes("set-environment"))).toBe(true);
  });

  it("with the scoped launch off, the fresh seat is restarted after the allow-list applies, as before", async () => {
    const { a, execs, launchFiles } = adapter(true);
    expect((await a.createSession("dev@rig", "/w", { OPENRIG_NODE_ID: "n1" })).ok).toBe(true);
    expect(launchFiles).toHaveLength(0);
    expect(execs.some((cmd) => cmd.startsWith("tmux respawn-pane"))).toBe(true);
  });
});
