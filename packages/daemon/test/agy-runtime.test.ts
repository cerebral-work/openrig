import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyAgyScreen, validateAgyMode, ensureAgyWorkspaceTrusted, registerAgyHook, readAgyConversationId,
  agySettingsPath, agyHooksPath, prepareAgyLaunch,
} from "../src/domain/agy-runtime.js";
import { agyPostureArg } from "../src/adapters/yolo-mode.js";
import { observeAgyPermission } from "../src/domain/permission-drift.js";
import { validateResumeToken } from "../src/domain/resume-token-validation.js";

// Live agy 1.4.0 captures (email, GCP project and workspace path redacted; screen structure verbatim).
const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/agy/${name}`, import.meta.url), "utf8");
const UUID = "3f2b8c1e-5a47-4d2e-9b6a-1c0e7d8f9a21";

describe("classifyAgyScreen over live 1.4.0 fixtures", () => {
  const cases: Array<[string, string]> = [
    ["trust-dialog", "trust"],
    ["idle-after-trust", "ready"],
    ["working-1", "working"],
    ["working-2", "working"],
    ["working-4", "working"],
    ["done", "ready"],
  ];
  for (const [name, expected] of cases) {
    it(`${name}.txt -> ${expected}`, () => expect(classifyAgyScreen(fixture(`${name}.txt`))).toBe(expected));
    it(`${name}.ansi -> ${expected}`, () => expect(classifyAgyScreen(fixture(`${name}.ansi`))).toBe(expected));
  }
  it("empty / garbage -> unknown", () => {
    expect(classifyAgyScreen("")).toBe("unknown");
    expect(classifyAgyScreen(null)).toBe("unknown");
    expect(classifyAgyScreen("bash-5.2$ ")).toBe("unknown");
  });
  it("the typed prompt text of a ready screen cannot fake a working state", () => {
    expect(classifyAgyScreen("> please say esc to cancel\n? for shortcuts      accept-edits")).toBe("ready");
  });
});

describe("launch posture", () => {
  it("always skips permissions; --mode only when set", () => {
    expect(agyPostureArg()).toBe(" --dangerously-skip-permissions");
    expect(agyPostureArg("")).toBe(" --dangerously-skip-permissions");
    expect(agyPostureArg("plan")).toBe(" --dangerously-skip-permissions --mode plan");
    expect(agyPostureArg("accept-edits")).toBe(" --dangerously-skip-permissions --mode accept-edits");
  });
  it("rejects an invalid mode (agy itself only warns)", () => {
    expect(() => agyPostureArg("bogus")).toThrow(/Invalid agy --mode "bogus"/);
    expect(() => validateAgyMode("AUTO")).toThrow();
    expect(validateAgyMode(" auto ")).toBe("auto");
  });
  it("observes the applied launch honestly (arguments only)", () => {
    expect(observeAgyPermission(agyPostureArg())).toMatchObject({ runtime: "agy", axis: "permission", state: "observed", value: "skip-permissions" });
    expect(observeAgyPermission(agyPostureArg("plan"))).toMatchObject({ state: "observed", value: "skip-permissions+plan" });
    expect(observeAgyPermission("--mode plan")).toMatchObject({ state: "unknown" });
  });
});

describe("resume token validation", () => {
  it("accepts a conversation UUID and rejects other shapes", () => {
    expect(validateResumeToken("agy", UUID)).toEqual({ ok: true, resumeType: "agy_id", token: UUID });
    expect(validateResumeToken("agy", "not-a-uuid")).toMatchObject({ ok: false });
    expect(validateResumeToken("agy", `${UUID};rm -rf /`)).toMatchObject({ ok: false });
  });
});

describe("agy config edits (temp HOME)", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agy-home-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  describe("trusted workspaces", () => {
    it("creates settings.json when absent", () => {
      expect(ensureAgyWorkspaceTrusted("/work/a", home)).toBe(true);
      expect(JSON.parse(fs.readFileSync(agySettingsPath(home), "utf8"))).toEqual({ trustedWorkspaces: ["/work/a"] });
    });
    it("is additive: preserves every other key and existing entries, keeps file mode", () => {
      const path = agySettingsPath(home);
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      const original = { model: "Gemini 4 Argon (Medium)", permissions: { allow: ["x"] }, toolPermission: "always-proceed", trustedWorkspaces: ["/old"] };
      fs.writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
      expect(ensureAgyWorkspaceTrusted("/work/b", home)).toBe(true);
      expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({ ...original, trustedWorkspaces: ["/old", "/work/b"] });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(nodePath.dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
    it("a second call for the same cwd writes nothing", () => {
      ensureAgyWorkspaceTrusted("/work/a", home);
      const before = fs.readFileSync(agySettingsPath(home), "utf8");
      const mtime = fs.statSync(agySettingsPath(home)).mtimeMs;
      expect(ensureAgyWorkspaceTrusted("/work/a", home)).toBe(false);
      expect(fs.readFileSync(agySettingsPath(home), "utf8")).toBe(before);
      expect(fs.statSync(agySettingsPath(home)).mtimeMs).toBe(mtime);
    });
    it("refuses to rewrite a malformed or non-object settings file", () => {
      const path = agySettingsPath(home);
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      fs.writeFileSync(path, "{not json");
      expect(() => ensureAgyWorkspaceTrusted("/w", home)).toThrow();
      expect(fs.readFileSync(path, "utf8")).toBe("{not json");
      fs.writeFileSync(path, JSON.stringify({ trustedWorkspaces: "/oops" }));
      expect(() => ensureAgyWorkspaceTrusted("/w", home)).toThrow(/not an array/);
    });
  });

  describe("hook registration", () => {
    const moshi = `{
  "moshi-hook": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "moshi-hook" } ] }
    ]
  },
  "moshi-operator-ask": { "PreToolUse": [ { "matcher": "ask", "hooks": [ { "type": "command", "command": "ask" } ] } ] }
}
`;
    it("creates hooks.json with a flat PreInvocation handler list", () => {
      expect(registerAgyHook("/pkg/openrig-agy-hook.sh", home)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(agyHooksPath(home), "utf8"));
      expect(parsed.openrig.PreInvocation).toEqual([{ type: "command", command: "bash '/pkg/openrig-agy-hook.sh'", timeout: 10 }]);
    });
    const bodyBefore = (raw: string) => raw.slice(0, raw.lastIndexOf("}")).trimEnd();
    it("is idempotent and leaves existing entries BYTE-FOR-BYTE untouched (raw text, not parsed objects)", () => {
      const path = agyHooksPath(home);
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      fs.writeFileSync(path, moshi);
      expect(registerAgyHook("/pkg/h.sh", home)).toBe(true);
      const once = fs.readFileSync(path, "utf8");
      // every original byte up to the closing brace is still there, in place
      expect(once.startsWith(bodyBefore(moshi) + ",\n")).toBe(true);
      expect(once.endsWith("\n}\n")).toBe(true);
      const parsed = JSON.parse(once);
      expect(Object.keys(parsed)).toEqual(["moshi-hook", "moshi-operator-ask", "openrig"]);
      expect(parsed.openrig.PreInvocation).toEqual([{ type: "command", command: "bash '/pkg/h.sh'", timeout: 10 }]);
      // second registration: no write at all
      expect(registerAgyHook("/pkg/h.sh", home)).toBe(false);
      expect(fs.readFileSync(path, "utf8")).toBe(once);
      // a moved script replaces ONLY the openrig value: bytes before it are identical
      expect(registerAgyHook("/pkg2/h.sh", home)).toBe(true);
      const moved = fs.readFileSync(path, "utf8");
      const cut = once.indexOf('"openrig"');
      expect(moved.slice(0, cut)).toBe(once.slice(0, cut));
      expect(JSON.parse(moved).openrig.PreInvocation[0].command).toContain("/pkg2/h.sh");
      expect(moved.split('"openrig"').length - 1).toBe(1); // replaced in place, not appended as a duplicate key
    });
    it("preserves unusual existing bytes: tabs, CRLF, \\u escapes, no trailing newline", () => {
      const path = agyHooksPath(home);
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      const odd = '{\r\n\t"caf\\u00e9": {"x": [1,2,\t3], "s": "a\\"}b{"}\r\n}';
      fs.writeFileSync(path, odd);
      registerAgyHook("/pkg/h.sh", home);
      const after = fs.readFileSync(path, "utf8");
      expect(after.startsWith(bodyBefore(odd))).toBe(true);
      expect(after.slice(bodyBefore(odd).length)).toMatch(/^,\r\n\t"openrig": \{\r\n\t\t"PreInvocation"/); // file's own EOL and indent
      expect(after).toContain('"caf\\u00e9"');
      expect(Object.keys(JSON.parse(after))).toEqual(["café", "openrig"]);
    });
    it("handles an empty object and a minified single-line file", () => {
      const path = agyHooksPath(home);
      fs.mkdirSync(nodePath.dirname(path), { recursive: true });
      fs.writeFileSync(path, "{}\n");
      registerAgyHook("/pkg/h.sh", home);
      expect(Object.keys(JSON.parse(fs.readFileSync(path, "utf8")))).toEqual(["openrig"]);
      const mini = '{"moshi-hook":{"PreToolUse":[]}}';
      fs.writeFileSync(path, mini);
      registerAgyHook("/pkg/h.sh", home);
      const after = fs.readFileSync(path, "utf8");
      expect(after.startsWith('{"moshi-hook":{"PreToolUse":[]},"openrig":')).toBe(true);
      expect(after.includes("\n")).toBe(false);
    });
    it("a hook-registration failure is a warning, a trust failure is fatal", () => {
      const hooks = agyHooksPath(home);
      fs.mkdirSync(nodePath.dirname(hooks), { recursive: true });
      fs.writeFileSync(hooks, "[]"); // not an object
      const result = prepareAgyLaunch({ cwd: "/w", homeDir: home, hookScriptPath: "/pkg/h.sh" });
      expect(result.warnings[0]).toMatch(/hook registration failed/);
      expect(JSON.parse(fs.readFileSync(agySettingsPath(home), "utf8")).trustedWorkspaces).toEqual(["/w"]);
      fs.writeFileSync(agySettingsPath(home), "[]");
      expect(() => prepareAgyLaunch({ cwd: "/w2", homeDir: home })).toThrow();
    });
  });

  describe("sidecar reader", () => {
    it("missing -> missing_sidecar; bad json -> parse_error; ok -> id; traversal refused", () => {
      expect(readAgyConversationId(home, "s@r")).toEqual({ ok: false, reason: "missing_sidecar" });
      fs.writeFileSync(nodePath.join(home, "s@r.json"), "{oops");
      expect(readAgyConversationId(home, "s@r")).toEqual({ ok: false, reason: "parse_error" });
      fs.writeFileSync(nodePath.join(home, "s@r.json"), JSON.stringify({ conversationId: UUID }));
      expect(readAgyConversationId(home, "s@r")).toEqual({ ok: true, conversationId: UUID });
      expect(readAgyConversationId(home, "../s@r")).toEqual({ ok: false, reason: "missing_sidecar" });
    });
  });
});

describe("openrig-agy-hook.sh", () => {
  const script = nodePath.resolve(import.meta.dirname, "../assets/agy-hook/openrig-agy-hook.sh");
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agy-hook-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  function run(payload: string, env: Record<string, string>): string {
    // Minimal env: nothing from the developer's own OPENRIG_* leaks into the hook.
    return execFileSync("bash", [script], { input: payload, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: home, ...env } });
  }
  const stateFile = () => nodePath.join(home, "state", "agy", "dev-impl@rig.json");

  it("writes <session>.json atomically when OPENRIG_SESSION_NAME is set, and prints {}", () => {
    const out = run(JSON.stringify({ conversationId: UUID, transcriptPath: "/x" }), { OPENRIG_SESSION_NAME: "dev-impl@rig", OPENRIG_HOME: home });
    expect(out.trim()).toBe("{}");
    const written = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    expect(written.conversationId).toBe(UUID);
    expect(fs.readdirSync(nodePath.dirname(stateFile())).filter((f) => f.startsWith("."))).toEqual([]);
    expect(readAgyConversationId(nodePath.dirname(stateFile()), "dev-impl@rig")).toEqual({ ok: true, conversationId: UUID });
  });
  it("exits 0 and writes nothing when OPENRIG_SESSION_NAME is unset", () => {
    const out = run(JSON.stringify({ conversationId: UUID }), { OPENRIG_HOME: home });
    expect(out.trim()).toBe("{}");
    expect(fs.existsSync(nodePath.join(home, "state"))).toBe(false);
  });
  it("ignores a payload without a UUID conversationId or with a hostile session name", () => {
    run(JSON.stringify({ conversationId: "../../etc/passwd" }), { OPENRIG_SESSION_NAME: "dev-impl@rig", OPENRIG_HOME: home });
    run(JSON.stringify({}), { OPENRIG_SESSION_NAME: "dev-impl@rig", OPENRIG_HOME: home });
    run(JSON.stringify({ conversationId: UUID }), { OPENRIG_SESSION_NAME: "../evil", OPENRIG_HOME: home });
    expect(fs.existsSync(nodePath.join(home, "state"))).toBe(false);
    expect(fs.existsSync(nodePath.join(home, "evil.json"))).toBe(false);
  });
});

describe("pod-aware preflight probe", () => {
  it("probes agy only when an agy member exists", async () => {
    const { verifyAgyRuntimeAvailable } = await import("../src/domain/rigspec-preflight.js");
    const spec = (runtime: string) => ({ pods: [{ id: "p", members: [{ id: "m", runtime }] }] }) as never;
    const ok: string[] = [];
    const exec = (async (cmd: string) => { ok.push(cmd); return ""; }) as never;
    expect(await verifyAgyRuntimeAvailable(spec("codex"), exec)).toEqual([]);
    expect(ok).toEqual([]);
    expect(await verifyAgyRuntimeAvailable(spec("agy"), exec)).toEqual([]);
    expect(ok).toEqual(["agy --version"]);
    const failing = (async () => { throw new Error("not found"); }) as never;
    expect((await verifyAgyRuntimeAvailable(spec("agy"), failing))[0]).toContain('Runtime "agy" not available');
  });
});

describe("legacy rigspec schema", () => {
  it("accepts runtime agy and still rejects unknown runtimes", async () => {
    const { LegacyRigSpecSchema } = await import("../src/domain/rigspec-schema.js");
    const spec = (runtime: string) => ({ schema_version: 1, name: "r", version: "1.0.0", nodes: [{ id: "w", runtime, cwd: "/" }], edges: [] });
    expect(LegacyRigSpecSchema.validate(spec("agy")).errors.filter((e: string) => e.includes("runtime"))).toEqual([]);
    expect(LegacyRigSpecSchema.validate(spec("nope")).errors.join("\n")).toContain("unknown runtime 'nope'");
  });
});
