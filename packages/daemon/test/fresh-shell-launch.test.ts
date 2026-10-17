import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const shell = { pid: 900, ppid: 1, command: "/bin/zsh", pgid: 900, tpgid: 900,
  executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" };

function fixture(options: { neverReady?: boolean; transportFailure?: boolean; shellBusy?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fresh-shell-launch-"));
  roots.push(root);
  let clock = 0;
  let paste = "";
  let screen = "";
  let probe = "";
  let launchPath = "";
  const calls: string[][] = [];
  const launches: string[] = [];
  const exec = vi.fn(async (args: string[]) => {
    calls.push(args);
    const cmd = args[1];
    if (cmd === "display-message") return args.at(-1) === "#{pane_pid}" ? "900" : "zsh";
    if (cmd === "load-buffer") paste = readFileSync(args.at(-1)!, "utf8");
    if (cmd === "paste-buffer") {
      if (paste.startsWith("printf ")) { probe = paste; screen = paste; }
      else { launches.push(paste); launchPath = paste.match(/'([^']+)'/)?.[1] ?? ""; }
    }
    if (cmd === "send-keys" && args.at(-1) === "Enter" && probe && launches.length === 0) {
      if (options.transportFailure) throw new Error("transport refused");
      // First Enter is lost while zsh initializes. Echoed input is NOT a receipt.
      if (clock >= 250 && !options.neverReady) {
        const parts = [...probe.matchAll(/'([^']*)'/g)].map(m => m[1]);
        screen = parts.slice(1).join("") + "\nfixture %";
      }
    }
    if (cmd === "capture-pane") return screen;
    return "";
  });
  let serial = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("legacy exec must not run"); }, {
    tmpName: () => join(root, `input-${serial++}.sh`),
    bufferName: () => `buffer-${serial++}`,
    writeFile: async (path, text, opts) => { const { writeFile } = await import("node:fs/promises"); await writeFile(path, text, opts); },
    unlink: async path => { const { unlink } = await import("node:fs/promises"); await unlink(path); },
  }, exec, {
    listProcesses: () => options.shellBusy ? [] : [shell],
    sleep: async ms => { clock += ms; },
  });
  return { adapter, calls, launches, get launchPath() { return launchPath; } };
}

describe("CER-2889 fresh shell launch", () => {
  it("allocates a sane initial size even when an attached tile is 50 by 2", async () => {
    const f = fixture();
    expect(await f.adapter.createSession("lead@fixture")).toEqual({ ok: true });
    const create = f.calls.find(args => args[1] === "new-session")!;
    expect(create.slice(create.indexOf("-x"), create.indexOf("-x") + 4)).toEqual(["-x", "160", "-y", "48"]);
  });

  it("waits for an executed sentinel, not its echo, before pasting the launch", async () => {
    const f = fixture();
    await f.adapter.createSession("lead@fixture");
    expect(await f.adapter.sendShellCommand("lead@fixture", "fixture-agent")).toEqual({ ok: true });
    const beforeLaunch = f.calls.slice(0, f.calls.findLastIndex(args => args[1] === "paste-buffer"));
    expect(beforeLaunch.filter(args => args[1] === "capture-pane").length).toBeGreaterThan(1);
    expect(f.launches).toHaveLength(1);
    expect(readFileSync(f.launchPath, "utf8")).toContain("fixture-agent");
  });

  it("times out without pasting a launch when only echoed sentinel input is visible", async () => {
    const f = fixture({ neverReady: true });
    await f.adapter.createSession("lead@fixture");
    expect(await f.adapter.sendShellCommand("lead@fixture", "fixture-agent")).toMatchObject({ ok: false, code: "shell_not_ready" });
    expect(f.launches).toEqual([]);
  });

  it("propagates handshake transport failure without pasting a launch", async () => {
    const f = fixture({ transportFailure: true });
    await f.adapter.createSession("lead@fixture");
    expect(await f.adapter.sendShellCommand("lead@fixture", "fixture-agent")).toMatchObject({ ok: false });
    expect(f.launches).toEqual([]);
  });

  it("does not type into a new pane without positive idle-shell process evidence", async () => {
    const f = fixture({ shellBusy: true });
    await f.adapter.createSession("lead@fixture");
    expect(await f.adapter.sendShellCommand("lead@fixture", "fixture-agent")).toMatchObject({ ok: false, code: "shell_not_ready" });
    expect(f.calls.some(args => ["send-keys", "paste-buffer"].includes(args[1]))).toBe(false);
  });

  it("does not send a handshake into an existing or already launched seat", async () => {
    const f = fixture();
    await f.adapter.sendShellCommand("existing@fixture", "fixture-agent");
    expect(f.calls.some(args => args[1] === "capture-pane")).toBe(false);
    expect(f.launches).toHaveLength(1);
  });

  it.each(["claude", "codex"] as const)("%s distinguishes unconsumed launch from an exited runtime", async runtime => {
    const f = fixture();
    await f.adapter.createSession("lead@fixture");
    await f.adapter.sendShellCommand("lead@fixture", "fixture-agent");
    vi.spyOn(f.adapter, "hasSession").mockResolvedValue(true);
    const binding = { nodeId: "n1", tmuxSession: "lead@fixture", cwd: "/fixture" } as NodeBinding;
    const deps = { tmux: f.adapter, listProcesses: () => [shell] };
    const adapter = runtime === "claude" ? new ClaudeCodeAdapter(deps) : new CodexRuntimeAdapter(deps);
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "launch_not_executed" });
    unlinkSync(f.launchPath); // consumption removes the script before executing the runtime
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "returned_to_shell" });
  });

  it.each(["claude", "codex"] as const)("%s does not call a busy shell wrapper an exited runtime", async runtime => {
    const f = fixture();
    vi.spyOn(f.adapter, "hasSession").mockResolvedValue(true);
    const binding = { nodeId: "n1", tmuxSession: "lead@fixture", cwd: "/fixture" } as NodeBinding;
    const deps = { tmux: f.adapter, listProcesses: () => [{ ...shell, tpgid: 901 }] };
    const adapter = runtime === "claude" ? new ClaudeCodeAdapter(deps) : new CodexRuntimeAdapter(deps);
    expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "awaiting_runtime" });
  });
});
