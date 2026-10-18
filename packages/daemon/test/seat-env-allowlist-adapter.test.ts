// Spec 0013 (SEC-178): allow-list mode fails closed. When the policy can't be applied, a launch is
// refused, never sent or started with what the seat inherited.
import { describe, it, expect } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { SEAT_ENV_DEFAULT_BASE, type SeatEnvPolicy } from "../src/domain/seat-launch-env-filter.js";

const POLICY: SeatEnvPolicy = { mode: "allowlist", base: SEAT_ENV_DEFAULT_BASE, exceptions: [], kubeconfig: "/scoped/k", rigs: [] };

function adapter(failing: string, policy: SeatEnvPolicy | null = POLICY) {
  const execs: string[] = [];
  const written: string[] = [];
  const fileOps: TmuxFileOps = {
    // Staged launch scripts only; sendText writes its paste payload through the same call.
    writeFile: async (_p, content) => { if (content.startsWith("/bin/rm -f --")) written.push(content); },
    unlink: async () => {},
    tmpName: () => "/tmp/openrig-send.sh",
    bufferName: () => "openrig_1_buf",
  };
  const a = new TmuxAdapter(async (cmd) => {
    execs.push(cmd);
    const sub = cmd.split(" ")[1] ?? "";
    if (sub === failing) throw new Error(`Command failed: ${cmd}`);
    if (sub === "new-session") return "%1\n";
    if (sub === "show-environment") return cmd.includes(" -g") ? "OP_SERVICE_ACCOUNT_TOKEN=x\nHOME=/h\n" : "OPENRIG_NODE_ID=n1\n-HOME\n";
    if (sub === "list-panes") return "%1|0|/w|80|24|1\n";
    if (sub === "display-message") return "bash\n";
    return "";
  }, fileOps);
  if (policy) a.setSeatEnvPolicy(() => policy, () => false);
  return { a, execs, written };
}

describe("seat env allow-list refusals (spec 0013)", () => {
  it("a command whose prologue can't be built is not sent", async () => {
    const { a, execs } = adapter("show-environment");
    expect(await a.sendShellCommand("dev@rig", "claude", undefined, { sourceInPane: true }))
      .toMatchObject({ ok: false, code: "seat_env_refused" });
    expect(execs.some((cmd) => /paste-buffer|send-keys|load-buffer/.test(cmd))).toBe(false);
  });

  it("a sent command is always staged behind the prologue, even a short one", async () => {
    const { a, written } = adapter("none");
    expect(await a.sendShellCommand("dev@rig", "claude", undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/unset "\$__openrig_n"[\s\S]*KUBECONFIG=[\s\S]*\nexec claude\n$/);
  });

  it("filter mode sends the short command inline, as before", async () => {
    const { a, written } = adapter("none", null);
    expect(await a.sendShellCommand("dev@rig", "claude", undefined, { stageIfLong: true, execInScript: true })).toEqual({ ok: true });
    expect(written).toEqual([]);
  });

  it("sendLaunchCommand stages behind the prologue in allow-list mode, and types as before in filter mode", async () => {
    const allow = adapter("none");
    expect(await allow.a.sendLaunchCommand("dev@rig", "claude --resume x")).toEqual({ ok: true });
    expect(allow.written).toHaveLength(1);
    expect(allow.written[0]).toMatch(/__openrig_names[\s\S]*\nclaude --resume x\n$/);
    const filter = adapter("none", null);
    expect(await filter.a.sendLaunchCommand("dev@rig", "claude --resume x")).toEqual({ ok: true });
    expect(filter.written).toEqual([]);
    expect(filter.execs.some((cmd) => cmd.startsWith("tmux send-keys") && cmd.includes("Enter"))).toBe(true);
  });

  it("an unreadable policy refuses a launch, with nothing sent (review r2, R3)", async () => {
    const { a, execs } = adapter("none", null);
    a.setSeatEnvPolicy(() => "unreadable", () => false);
    expect(await a.sendLaunchCommand("dev@rig", "claude")).toMatchObject({ ok: false, code: "seat_env_refused" });
    expect(await a.createSession("dev@rig", "/w", { OPENRIG_NODE_ID: "n1" })).toMatchObject({ ok: false, code: "seat_env_refused" });
    expect(execs.some((cmd) => /paste-buffer|send-keys|load-buffer/.test(cmd))).toBe(false);
  });

  it("a fresh seat whose environment can't be set is removed and refused", async () => {
    const { a, execs } = adapter("set-environment");
    expect(await a.createSession("dev@rig", "/w", { OPENRIG_NODE_ID: "n1" })).toMatchObject({ ok: false, code: "seat_env_refused" });
    expect(execs.some((cmd) => cmd.startsWith("tmux kill-session"))).toBe(true);
    expect(execs.some((cmd) => cmd.startsWith("tmux respawn-pane"))).toBe(false);
  });

  it("a respawn whose environment can't be set does not respawn", async () => {
    const { a, execs } = adapter("set-environment");
    expect(await a.respawnPane("%1", "claude --resume x")).toMatchObject({ ok: false, code: "seat_env_refused" });
    expect(execs.some((cmd) => cmd.startsWith("tmux respawn-pane"))).toBe(false);
  });
});
