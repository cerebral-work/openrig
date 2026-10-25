// Spec 0020: runtime.claude_code.channels makes every Claude launch OpenRig makes (fresh launch, fork, resume and restore;
// ordinary, kernel, team-default and full-bypass seats; shell and argv forms) register its plugin channels with one
// `--channels <entries...>`. Unset, empty or invalid, every command is as it was. Through the real command builders and
// the real settings resolver (the setting's env name), with an inert transport: nothing is executed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { claudeChannels, operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { claudeCommandSessionToken } from "../src/domain/native-process-lineage.js";
import { SettingsStore, parseClaudeChannels } from "../src/domain/user-settings/settings-store.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const ENV = "OPENRIG_RUNTIME_CLAUDE_CODE_CHANNELS";
const ENTRIES = ["plugin:example-channel@example", "plugin:second@example"];
const ARGV = ["--channels", ...ENTRIES];
/** The option as the shell form writes it. */
const SHELL = ARGV.map((a) => ` ${shellQuote(a)}`).join("");

function setting(value: string | undefined): void {
  vi.stubEnv(ENV, value);
}

type Kind = "ordinary" | "kernel" | "team" | "full-bypass";
const KINDS: Kind[] = ["ordinary", "kernel", "team", "full-bypass"];
function binding(kind: Kind): NodeBinding {
  return {
    id: "binding", nodeId: "node", cwd: "/inert/seat", tmuxSession: "seat@rig", launchPosture: kind === "full-bypass" ? "full_bypass" : "floor",
    ...(kind === "kernel" ? { kernelAuthority: true } : {}), ...(kind === "team" ? { teamPermissionDefault: true } : {}),
    ...(kind === "full-bypass" ? { nonInterruptive: true } : {}),
  } as NodeBinding;
}

function inert() {
  const send = vi.fn(async () => ({ ok: false as const, message: "inert transport: no native execution" }));
  const tmux = { sendShellCommand: send, sendText: send } as unknown as TmuxAdapter;
  const fsOps = { readFile: () => { throw new Error("missing"); }, exists: () => false,
    writeFile: vi.fn(() => { throw new Error("unexpected settings write"); }), mkdirp: vi.fn(), copyFile: vi.fn() };
  return { send, tmux, fsOps };
}

type Path = "fresh" | "fork" | "resume" | "restore";
const PATHS: Path[] = ["fresh", "fork", "resume", "restore"];
/** The composed command each path sends to the pane. */
async function command(path: Path, kind: Kind): Promise<string> {
  vi.stubEnv("OPENRIG_YOLO", kind === "full-bypass" ? "1" : "0");
  const t = inert();
  const b = binding(kind);
  if (path === "restore") {
    await new ClaudeResumeAdapter(t.tmux).resume("seat@rig", "claude_id", "original", b.cwd, b.launchPosture as "floor" | "full_bypass",
      null, undefined, b.nodeId, null, b.nonInterruptive, b.kernelAuthority, b.teamPermissionDefault);
  } else {
    await new ClaudeCodeAdapter({ ...t, sessionIdFactory: () => "fixed-session-id" }).launchHarness(b, { name: "seat", ...(path === "resume" ? { resumeToken: "original" } : {}),
      ...(path === "fork" ? { forkSource: { kind: "native_id" as const, value: "original" } } : {}) });
  }
  expect(t.fsOps.writeFile).not.toHaveBeenCalled();
  return t.send.mock.calls[0]![1] as string;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("runtime.claude_code.channels reaches every Claude launch exactly once", () => {
  for (const path of PATHS) for (const kind of KINDS) {
    it(`${path}, ${kind} seat: set adds one --channels with the entries; unset leaves the command as it was`, async () => {
      setting(undefined);
      const off = await command(path, kind);
      setting(ENTRIES.join(","));
      const on = await command(path, kind);

      expect(count(on, SHELL)).toBe(1);
      expect(count(on, shellQuote("--channels"))).toBe(1);
      expect(on.replace(SHELL, "")).toBe(off);
      expect(off).not.toContain("--channels");
      // The variadic option is followed by another flag, so Claude ends the list where OpenRig ends it.
      expect(on.slice(on.indexOf(SHELL) + SHELL.length)).toMatch(/^ '?--/);
    });
  }

  it("an empty or invalid value leaves every command as unset (a bad value never stops a seat)", async () => {
    for (const value of ["", "  ", "plugin:a@b,,plugin:c@d", "server:example", "plugin:no-marketplace", "--channels",
      "plugin:a@b --settings {}", "plugin:a@b;rm"]) {
      for (const path of PATHS) for (const kind of KINDS) {
        setting(undefined);
        const off = await command(path, kind);
        setting(value);
        expect(await command(path, kind), `${value} on ${path}/${kind}`).toBe(off);
      }
    }
  });

  it("the argv form (managed launches) ends the operational flags with the option; other runtimes are untouched", () => {
    for (const choice of [{}, { kernelAuthority: true }, { teamPermissionDefault: true }, { nonInterruptive: true, launchPosture: "full_bypass" as const },
      { permissionMode: "plan" }]) {
      for (const managedCompaction of [false, true]) {
        const off = operationalLaunchArgs("claude-code", { ...choice, managedCompaction, claudeChannels: [] });
        const on = operationalLaunchArgs("claude-code", { ...choice, managedCompaction, claudeChannels: ENTRIES });
        expect(on).toEqual([...off, ...ARGV]);
      }
    }
    setting(ENTRIES.join(","));
    for (const runtime of ["codex", "pi", "terminal"]) {
      expect(operationalLaunchArgs(runtime, {})).toEqual(operationalLaunchArgs(runtime, { claudeChannels: ENTRIES }));
      expect(operationalLaunchArgs(runtime, {})).not.toContain("--channels");
    }
  });

  it("native identity still reads the session from a command line carrying the option", () => {
    const argv = ["--permission-mode", "acceptEdits", ...operationalLaunchArgs("claude-code", { claudeChannels: ENTRIES, managedCompaction: false }),
      "--session-id", "native-id"];
    const line = ["claude", ...argv].join(" ");
    expect(claudeCommandSessionToken(line)).toBe("native-id");
    expect(claudeCommandSessionToken(`${line} --fork-session --resume parent`)).toBe("native-id");
    // The option with no entry, or an unknown flag beside it, is still no proof.
    expect(claudeCommandSessionToken("claude --channels --session-id native-id")).toBeNull();
    expect(claudeCommandSessionToken(`${line} --unknown-flag`)).toBeNull();
  });

  it("is read through the real settings resolver at each launch; an unreadable store reads as none", () => {
    setting(ENTRIES.join(" , "));
    expect(claudeChannels()).toEqual(ENTRIES);
    expect(claudeChannels({ resolveOne: () => { throw new Error("unreadable config"); } } as unknown as SettingsStore)).toEqual([]);
  });
});

describe("parseClaudeChannels", () => {
  it("takes comma-separated plugin entries, trimmed; empty is none", () => {
    expect(parseClaudeChannels("")).toEqual([]);
    expect(parseClaudeChannels("   ")).toEqual([]);
    expect(parseClaudeChannels(" plugin:example-channel@example , plugin:second@example ")).toEqual(ENTRIES);
    expect(parseClaudeChannels("plugin:a.b_c-1@market_place.2")).toEqual(["plugin:a.b_c-1@market_place.2"]);
  });

  it("refuses an empty item, a server entry, a flag, and anything that is not plugin:<name>@<marketplace>", () => {
    expect(() => parseClaudeChannels("plugin:a@b,,plugin:c@d")).toThrow("item 2 is empty");
    for (const bad of ["server:example", "plugin:no-marketplace", "plugin:@market", "plugin:name@", "--channels",
      "--dangerously-load-development-channels", "plugin:a@b --settings", "plugin:a@b;x", "example"]) {
      expect(() => parseClaudeChannels(bad), bad).toThrow("is not a plugin channel");
    }
  });
});
