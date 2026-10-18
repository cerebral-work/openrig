// Spec 0017 items 1-3 (SEC-183) at the tmux adapter: a launch marked with its runtime carries that runtime's daemon
// secrets in its staged script, and nothing else does. tmux commands are recorded, not run; the staged script runs in a
// real shell. Every child gets an explicit minimal env.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";
import { buildDaemonSecretResolver, SECRET_SCRIPT_TRACE_GUARD } from "../src/domain/seat-secret-launch.js";

const SENTINEL = "SENTINELVALUE0017B";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(paneShell = "bash") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s17b-tmux-")); roots.push(root);
  const dir = path.join(root, "seat-env", "launch");
  const files = new Map<string, string>();
  let n = 0;
  const fileOps: TmuxFileOps = {
    tmpName: () => path.join(os.tmpdir(), `openrig-tmux-send-${process.pid}-0000000${n++}-0000-0000-0000-000000000000.txt`),
    bufferName: () => "buffer",
    writeFile: vi.fn(async (p: string, text: string) => { files.set(p, text); }),
    unlink: vi.fn(async (p: string) => { files.delete(p); }),
  };
  const commands: string[] = [];
  const exec = vi.fn(async (command: string) => {
    commands.push(command);
    if (command.includes("#{pane_current_command}")) return paneShell;
    return "";
  });
  const adapter = new TmuxAdapter(exec, fileOps);
  adapter.setSecretLaunch(buildDaemonSecretResolver({ ANTHROPIC_API_KEY: SENTINEL }, { omp: { OMP_EXTRA_API_KEY: SENTINEL } }), dir);
  const script = () => [...files].find(([p]) => p.startsWith(`${dir}/`));
  // Everything that left the adapter: tmux commands and the pasted invocation (the buffer file's text).
  const record = () => [...commands, ...[...files].filter(([p]) => !p.startsWith(`${dir}/`)).map(([, text]) => text),
    ...vi.mocked(fileOps.writeFile).mock.calls.filter(([p]) => !String(p).startsWith(`${dir}/`)).map(([, text]) => String(text))];
  return { root, dir, files, commands, adapter, script, record, fileOps };
}

describe("a marked runtime launch carries its daemon secrets (REQ-0017-02, -09, -10, -16, -17)", () => {
  it("stages a hardened script in the 0700 directory; nothing that left the adapter holds a value", async () => {
    const f = fixture();
    expect(await f.adapter.sendShellCommand("seat", "claude --resume x", undefined, { sourceInPane: true, runtimeLaunch: "claude-code" })).toEqual({ ok: true });
    const [p, text] = f.script()!;
    expect(fs.lstatSync(f.dir).mode & 0o777).toBe(0o700);
    const lines = text.split("\n");
    expect(lines[0]).toBe(SECRET_SCRIPT_TRACE_GUARD);
    expect(lines[1]).toMatch(/^\/bin\/rm -f -- /);
    expect(lines).toContain(`export ANTHROPIC_API_KEY='${SENTINEL}'`);
    expect(lines.findIndex((l) => l.startsWith("export "))).toBeLessThan(lines.findIndex((l) => l.includes("claude --resume x")));
    for (const line of lines.filter((l) => l.includes(SENTINEL))) expect(line).toMatch(/^export [A-Z_]+='[^']*'$/);
    expect(f.record().some((t) => t.includes(SENTINEL))).toBe(false);
    expect(f.record().some((t) => t.includes(p))).toBe(true);
  });

  it("gives each runtime only its own: OMP gets its extra key, Claude doesn't", async () => {
    const claude = fixture();
    await claude.adapter.sendShellCommand("seat", "claude", undefined, { runtimeLaunch: "claude-code" });
    expect(claude.script()![1]).not.toContain("OMP_EXTRA_API_KEY");
    const omp = fixture();
    await omp.adapter.sendShellCommand("seat", "omp", undefined, { runtimeLaunch: "omp", stageIfLong: true });
    expect(omp.script()![1]).toContain("export OMP_EXTRA_API_KEY=");
  });

  it("an unmarked command (a probe, a metadata command, a context delivery) carries none", async () => {
    const f = fixture();
    await f.adapter.sendShellCommand("seat", "printf probe", undefined, { sourceInPane: true });
    expect(f.script()).toBeUndefined();
    expect([...f.files.values()].some((t) => t.includes(SENTINEL) || t.includes(SECRET_SCRIPT_TRACE_GUARD))).toBe(false);
  });

  it("a short Pi-style command is staged, never typed, when it carries secrets", async () => {
    const f = fixture();
    await f.adapter.sendShellCommand("seat", "pi", undefined, { stageIfLong: true, execInScript: true, runtimeLaunch: "claude-code" });
    expect(f.script()).toBeDefined();
    const unmarked = fixture();
    await unmarked.adapter.sendShellCommand("seat", "pi", undefined, { stageIfLong: true, execInScript: true });
    // Typed, as today: no script is written for it.
    expect(vi.mocked(unmarked.fileOps.writeFile).mock.calls.some(([, t]) => String(t).includes("exec pi"))).toBe(false);
  });

  it("sendLaunchCommand stages a marked launch with secrets; unmarked it types, as today", async () => {
    const f = fixture();
    await f.adapter.sendLaunchCommand("seat", "stub-runtime", { runtimeLaunch: "claude-code" });
    expect(f.script()![1]).toContain("exec stub-runtime");
    const probe = fixture();
    await probe.adapter.sendLaunchCommand("seat", "printf metadata");
    expect(probe.script()).toBeUndefined();
  });

  it("a fish pane runs the script with /bin/sh, never sources it (REQ-0017-18)", async () => {
    const f = fixture("fish");
    await f.adapter.sendShellCommand("seat", "claude", undefined, { sourceInPane: true, runtimeLaunch: "claude-code" });
    const [p] = f.script()!;
    // The pasted invocation, not the script (whose own rm line names its path).
    const pasted = vi.mocked(f.fileOps.writeFile).mock.calls.filter(([w]) => !String(w).startsWith(`${f.dir}/`))
      .map(([, t]) => String(t)).find((t) => t.includes(p))!;
    expect(pasted.trim()).toBe(`/bin/sh '${p}'`);
    expect(pasted).not.toContain("source");
  });

  it("a refused directory refuses the launch and writes nothing (REQ-0017-11)", async () => {
    const f = fixture();
    fs.mkdirSync(f.dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(f.dir, 0o755);
    expect(await f.adapter.sendShellCommand("seat", "claude", undefined, { runtimeLaunch: "claude-code" }))
      .toMatchObject({ ok: false, code: "secret_launch_dir_refused" });
    expect(f.files.size).toBe(0);
  });

  it("the staged script delivers the value to the runtime, deletes itself first, and a traced shell prints no value", () => {
    return (async () => {
      const f = fixture();
      await f.adapter.sendShellCommand("seat", `printf %s "$ANTHROPIC_API_KEY" > "${path.join(f.root, "runtime-saw")}"`, undefined,
        { sourceInPane: true, runtimeLaunch: "claude-code" });
      const [p, text] = f.script()!;
      fs.writeFileSync(p, text, { mode: 0o600 });
      const run = spawnSync("bash", ["-c", 'set -x; ( . "$1" )', "_", p], { env: { PATH: process.env.PATH!, HOME: f.root }, encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(fs.readFileSync(path.join(f.root, "runtime-saw"), "utf8")).toBe(SENTINEL);
      expect(run.stderr).not.toContain(SENTINEL);
      expect(fs.existsSync(p)).toBe(false);
    })();
  });

  it("discardSecretLaunch removes an unconsumed secret script after the readiness outcome (REQ-0017-07)", async () => {
    const f = fixture();
    await f.adapter.sendShellCommand("seat", "claude", undefined, { runtimeLaunch: "claude-code" });
    expect(f.script()).toBeDefined();
    await f.adapter.discardSecretLaunch("seat");
    expect(f.script()).toBeUndefined();
  });
});
