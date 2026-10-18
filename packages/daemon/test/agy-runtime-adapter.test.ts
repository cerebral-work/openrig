import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgyRuntimeAdapter, type AgyAdapterFsOps } from "../src/adapters/agy-runtime-adapter.js";
import { AgyResumeAdapter } from "../src/adapters/agy-resume.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { agySettingsPath } from "../src/domain/agy-runtime.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/agy/${name}.txt`, import.meta.url), "utf8");
const UUID = "3f2b8c1e-5a47-4d2e-9b6a-1c0e7d8f9a21";

function mockTmux(screen: string, paneCommand = "agy", overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => paneCommand),
    capturePaneContent: vi.fn(async () => screen),
    ...overrides,
  } as unknown as TmuxAdapter);
}

function memFs(files: Record<string, string> = {}): AgyAdapterFsOps & { _store: Record<string, string> } {
  const store = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    remove: (p: string) => { delete store[p]; },
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    _store: store,
  };
}

function binding(over: Partial<NodeBinding> = {}): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "dev-impl@rig", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/work/proj", ...over };
}

describe("AgyRuntimeAdapter", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agy-adapter-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const make = (tmux: TmuxAdapter, fsOps = memFs()) =>
    new AgyRuntimeAdapter({ tmux, fsOps, stateRoot: "/state/agy", homeDir: home, hookScriptPath: "/pkg/hook.sh", sleep: async () => {}, pollMs: 1, maxWaitMs: 3 });
  const sentCommand = (tmux: TmuxAdapter) => (tmux.sendShellCommand as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as string);

  describe("launchHarness", () => {
    it("fresh launch: skip-permissions, no --mode, in cwd, no resume token (deferred)", async () => {
      const tmux = mockTmux("");
      const result = await make(tmux).launchHarness(binding(), { name: "dev-impl@rig" });
      expect(sentCommand(tmux)).toEqual(["cd '/work/proj' && agy --dangerously-skip-permissions"]);
      expect(result).toEqual({ ok: true, appliedLaunch: expect.objectContaining({ runtime: "agy", value: "skip-permissions" }) });
      expect(result).not.toHaveProperty("resumeToken");
    });
    it("adds --mode when the seat sets one", async () => {
      const tmux = mockTmux("");
      await make(tmux).launchHarness(binding({ permissionMode: "plan" }), { name: "x" });
      expect(sentCommand(tmux)[0]).toBe("cd '/work/proj' && agy --dangerously-skip-permissions --mode plan");
    });
    it("rejects an invalid --mode without launching", async () => {
      const tmux = mockTmux("");
      const result = await make(tmux).launchHarness(binding({ permissionMode: "yolo" }), { name: "x" });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Invalid agy --mode "yolo"') });
      expect(sentCommand(tmux)).toEqual([]);
      expect(fs.existsSync(agySettingsPath(home))).toBe(false);
    });
    it("seeds trust for the seat cwd before launching, preserving other settings keys", async () => {
      fs.mkdirSync(nodePath.dirname(agySettingsPath(home)), { recursive: true });
      fs.writeFileSync(agySettingsPath(home), JSON.stringify({ model: "M", trustedWorkspaces: ["/other"] }));
      const tmux = mockTmux("");
      await make(tmux).launchHarness(binding(), { name: "x" });
      expect(JSON.parse(fs.readFileSync(agySettingsPath(home), "utf8"))).toEqual({ model: "M", trustedWorkspaces: ["/other", "/work/proj"] });
    });
    it("fails the launch (no command sent) when trust cannot be provisioned", async () => {
      fs.mkdirSync(nodePath.dirname(agySettingsPath(home)), { recursive: true });
      fs.writeFileSync(agySettingsPath(home), "{broken");
      const tmux = mockTmux("");
      const result = await make(tmux).launchHarness(binding(), { name: "x" });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining("trust provisioning failed") });
      expect(sentCommand(tmux)).toEqual([]);
    });
    it("drops a stale conversation-id sidecar on fresh launch only", async () => {
      const fsOps = memFs({ "/state/agy/dev-impl@rig.json": JSON.stringify({ conversationId: UUID }) });
      await make(mockTmux(""), fsOps).launchHarness(binding(), { name: "x" });
      expect(fsOps._store["/state/agy/dev-impl@rig.json"]).toBeUndefined();
    });
    it("refuses fork and resumeToken+forkSource", async () => {
      const a = make(mockTmux(""));
      expect(await a.launchHarness(binding(), { name: "x", forkSource: { kind: "native_id", value: UUID } })).toMatchObject({ ok: false, error: expect.stringContaining("fork") });
      expect(await a.launchHarness(binding(), { name: "x", resumeToken: UUID, forkSource: { kind: "native_id", value: UUID } })).toMatchObject({ ok: false, error: expect.stringContaining("mutually exclusive") });
    });
    it("resume launches with --conversation <uuid> and returns the token once agy is ready", async () => {
      const tmux = mockTmux(fixture("idle-after-trust"));
      const result = await make(tmux).launchHarness(binding({ permissionMode: "auto" }), { name: "x", resumeToken: UUID });
      expect(sentCommand(tmux)).toEqual([`cd '/work/proj' && agy --dangerously-skip-permissions --mode auto --conversation '${UUID}'`]);
      expect(result).toMatchObject({ ok: true, resumeToken: UUID, resumeType: "agy_id" });
    });
    it("resume with a malformed token is refused before any launch", async () => {
      const tmux = mockTmux("");
      expect(await make(tmux).launchHarness(binding(), { name: "x", resumeToken: "abc; rm -rf /" })).toMatchObject({ ok: false });
      expect(sentCommand(tmux)).toEqual([]);
    });
  });

  describe("AgyResumeAdapter outcomes", () => {
    const resume = (tmux: TmuxAdapter) =>
      new AgyResumeAdapter(tmux, { homeDir: home, sleep: async () => {}, pollMs: 1, maxWaitMs: 2 }).resume("s@r", "agy_id", UUID, "/work/proj");
    it("trust dialog -> attention_required with evidence, never answered", async () => {
      const tmux = mockTmux(fixture("trust-dialog"));
      const r = await resume(tmux);
      expect(r).toMatchObject({ ok: false, code: "attention_required" });
      // Only the launch command itself (typed + its own Enter) reaches the pane; nothing answers the dialog.
      expect(tmux.sendText).toHaveBeenCalledTimes(1);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
    });
    // A shell label alone isn't a return to the shell: agy starts from a launch script, which holds the pane the same
    // way while agy loads. Only a proven idle shell ends the resume (cw.4.1, as Claude and Codex do).
    const startedAt = "Fri Oct 16 15:00:00 2026";
    const shell = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: "-bash", executableName: "bash", startedAt };
    const launchScript = { pid: 11, ppid: 10, pgid: 11, tpgid: 11, command: "/bin/sh /tmp/openrig-tmux-send.txt", executableName: "sh", startedAt };
    const resumeWithTree = (rows: Array<typeof shell>) =>
      new AgyResumeAdapter(mockTmux("$ ", "bash", { getPanePid: vi.fn(async () => 10) } as Partial<TmuxAdapter>),
        { homeDir: home, sleep: async () => {}, pollMs: 1, maxWaitMs: 2, listProcesses: () => rows }).resume("s@r", "agy_id", UUID, "/work/proj");
    it("pane back at a proven idle shell -> retry_fresh", async () => {
      expect(await resumeWithTree([shell])).toMatchObject({ ok: false, code: "retry_fresh" });
    });
    it("shell label while the launch script still holds the pane -> attention_required, launch retained", async () => {
      expect(await resumeWithTree([{ ...shell, tpgid: 11 }, launchScript])).toMatchObject({ ok: false, code: "attention_required",
        message: expect.stringContaining("launch retained") });
    });
    it("canResume requires agy_id with a UUID", () => {
      const r = new AgyResumeAdapter(mockTmux(""));
      expect(r.canResume("agy_id", UUID)).toBe(true);
      expect(r.canResume("agy_id", "x")).toBe(false);
      expect(r.canResume("codex_id", UUID)).toBe(false);
    });
  });

  describe("checkReady", () => {
    const ready = (screen: string, cmd = "agy") => make(mockTmux(screen, cmd)).checkReady(binding());
    it("idle screen is ready", async () => expect(await ready(fixture("idle-after-trust"))).toEqual({ ready: true }));
    it("done screen is ready", async () => expect(await ready(fixture("done"))).toEqual({ ready: true }));
    it("trust dialog is NOT ready, named trust_gate, and is never answered", async () => {
      const tmux = mockTmux(fixture("trust-dialog"));
      const r = await make(tmux).checkReady(binding());
      expect(r).toMatchObject({ ready: false, code: "trust_gate" });
      expect(r.reason).toMatch(/trust/i);
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      expect(tmux.sendText).not.toHaveBeenCalled();
    });
    it("working screens are not ready", async () => {
      for (const f of ["working-1", "working-2", "working-4"]) expect((await ready(fixture(f))).ready).toBe(false);
    });
    it("shell in the foreground / unknown screen / no session are not ready", async () => {
      expect(await ready("$ ", "bash")).toMatchObject({ ready: false, code: "not_running" });
      expect((await ready("something else")).ready).toBe(false);
      expect(await make(mockTmux("", "agy", { hasSession: vi.fn(async () => false) })).checkReady(binding())).toMatchObject({ ready: false });
      expect(await make(mockTmux("")).checkReady(binding({ tmuxSession: null }))).toMatchObject({ ready: false });
    });
  });

  describe("deliverStartup (codex-equivalent file delivery)", () => {
    const file = (over: Partial<ResolvedStartupFile>): ResolvedStartupFile => ({
      path: "role.md", absolutePath: "/src/role.md", ownerRoot: "/src", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"], ...over,
    });
    it("merges guidance into AGENTS.md, installs skills under .agents/skills, types send_text into the TUI", async () => {
      const fsOps = memFs({ "/src/guide.md": "GUIDE", "/src/s/SKILL.md": "# SKILL x", "/src/note.txt": "hello agent" });
      const tmux = mockTmux("");
      const result = await make(tmux, fsOps).deliverStartup([
        file({ path: "guide.md", absolutePath: "/src/guide.md" }),
        file({ path: "SKILL.md", absolutePath: "/src/s/SKILL.md" }),
        file({ path: "note.txt", absolutePath: "/src/note.txt" }),
      ], binding());
      expect(result).toMatchObject({ delivered: 3, failed: [] });
      expect(fsOps._store["/work/proj/AGENTS.md"]).toContain("GUIDE");
      expect(fsOps._store["/work/proj/.agents/skills/s/SKILL.md"]).toBe("# SKILL x");
      expect(tmux.sendText).toHaveBeenCalledWith("dev-impl@rig", "hello agent");
    });
    it("reports a missing required file as failed", async () => {
      const result = await make(mockTmux(""), memFs()).deliverStartup([file({ absolutePath: "/nope.md" })], binding());
      expect(result.failed).toHaveLength(1);
    });
  });

  describe("deferred resume-token capture", () => {
    const hookSidecar = { readConversationId: (name: string) => name === "dev-impl@rig"
      ? { ok: true as const, conversationId: UUID } : { ok: false as const, reason: "missing_sidecar" } };
    it("captures the id the hook wrote", async () => {
      expect(await deriveResumeToken({ runtime: "agy", sessionName: "dev-impl@rig" }, { agyStateStore: hookSidecar }))
        .toEqual({ outcome: "captured", resumeType: "agy_id", token: UUID });
    });
    it("before the first turn there is no sidecar: an honest skip, not a failure", async () => {
      expect(await deriveResumeToken({ runtime: "agy", sessionName: "other@rig" }, { agyStateStore: hookSidecar }))
        .toEqual({ outcome: "skipped", reason: "missing_sidecar" });
    });
    it("a malformed id is refused; an absent dep is a noop", async () => {
      expect(await deriveResumeToken({ runtime: "agy", sessionName: "s" }, { agyStateStore: { readConversationId: () => ({ ok: true, conversationId: "zzz" }) } }))
        .toEqual({ outcome: "skipped", reason: "invalid_token" });
      expect(await deriveResumeToken({ runtime: "agy", sessionName: "s" }, {})).toEqual({ outcome: "noop" });
    });
    it("the adapter reads the sidecar from its stateRoot (hook -> adapter -> capture)", async () => {
      const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agy-state-"));
      try {
        const adapter = new AgyRuntimeAdapter({ tmux: mockTmux(""), fsOps: memFs(), stateRoot: root, homeDir: home });
        expect(await deriveResumeToken({ runtime: "agy", sessionName: "dev-impl@rig" }, { agyStateStore: adapter })).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
        fs.writeFileSync(nodePath.join(root, "dev-impl@rig.json"), JSON.stringify({ conversationId: UUID }));
        expect(await deriveResumeToken({ runtime: "agy", sessionName: "dev-impl@rig" }, { agyStateStore: adapter })).toMatchObject({ outcome: "captured", token: UUID });
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  });
});

describe("ResumeMetadataRefresher agy deferred capture (snapshot/teardown path)", () => {
  const session = (over: Record<string, unknown> = {}) => ({
    sessionId: "sid1", sessionName: "dev-impl@rig", runtime: "agy", resumeType: null, resumeToken: null, ...over,
  });
  async function setup(store: { readConversationId(n: string): { ok: true; conversationId: string } | { ok: false; reason: string } } | undefined) {
    const { ResumeMetadataRefresher } = await import("../src/domain/resume-metadata-refresher.js");
    const sessionRegistry = { updateResumeToken: vi.fn(() => true), markResumeProbeResult: vi.fn() };
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: sessionRegistry as never, tmuxAdapter: mockTmux(""), agyStateStore: store });
    return { refresher, sessionRegistry };
  }
  const hook = { readConversationId: () => ({ ok: true as const, conversationId: UUID }) };

  it("null-fills agy_id from the hook sidecar", async () => {
    const { refresher, sessionRegistry } = await setup(hook);
    await refresher.refresh([session()] as never, { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sid1", "agy_id", UUID, "scrape");
  });
  it("before the first turn (no sidecar) it writes nothing", async () => {
    const { refresher, sessionRegistry } = await setup({ readConversationId: () => ({ ok: false, reason: "missing_sidecar" }) });
    await refresher.refresh([session()] as never, { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });
  it("never clobbers a present token; an equal id only re-stamps freshness", async () => {
    const { refresher, sessionRegistry } = await setup({ readConversationId: () => ({ ok: true, conversationId: "11111111-1111-4111-8111-111111111111" }) });
    await refresher.refresh([session({ resumeToken: UUID, resumeType: "agy_id" })] as never, { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
    const same = await setup(hook);
    await same.refresher.refresh([session({ resumeToken: UUID, resumeType: "agy_id" })] as never, { fillNullOnly: true });
    expect(same.sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sid1", "resumable");
  });
  it("without the store dependency agy is a silent no-op", async () => {
    const { refresher, sessionRegistry } = await setup(undefined);
    await refresher.refresh([session()] as never, { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });
});
