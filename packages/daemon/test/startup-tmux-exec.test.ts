import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaemon } from "../src/startup.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import type { ArgvExecFn, ExecFn, TmuxAdapter } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import { removeTmuxTestRoot } from "./helpers/tmux-test-socket.js";
import { OPENRIG_HOME } from "../src/openrig-compat.js";
import { secretLaunchDirPath } from "../src/domain/secret-launch-dir.js";

const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

function argvExecOf(adapter: TmuxAdapter): ArgvExecFn | undefined {
  return (adapter as unknown as { argvExec?: ArgvExecFn }).argvExec;
}

// A full daemon composition took 3-28 s per file on a loaded host.
describe("createDaemon tmux exec wiring", { timeout: 120000 }, () => {
  let tmuxDir: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // better-sqlite3 picks its native addon by process.platform on first open; load the host's one first.
  beforeAll(() => { new Database(":memory:").close(); });
  beforeEach(() => {
    // Any real tmux call during composition reaches an empty private directory, never a live server.
    tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-startup-tmux-"));
    vi.stubEnv("TMUX_TMPDIR", tmuxDir);
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    removeTmuxTestRoot(tmuxDir);
  });

  it.skipIf(process.platform === "win32")("REQ-0017-12: startup empties the private launch directory before serving and gives it to the tmux adapter", async () => {
    const dir = secretLaunchDirPath(OPENRIG_HOME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(dir), 0o700); fs.chmodSync(dir, 0o700);
    const leftover = path.join(dir, "openrig-tmux-send-1-left-by-a-crash.txt");
    fs.writeFileSync(leftover, "export SENTINEL_TOKEN='sentinel'\n", { mode: 0o600 });
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
    try {
      expect(fs.existsSync(leftover)).toBe(false);
      expect((daemon.deps.tmuxAdapter as unknown as { secretLaunchDir?: string }).secretLaunchDir).toBe(dir);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });

  it.skipIf(process.platform === "win32")("REQ-0017-11: an unsafe private launch directory is not configured, and its files are left alone", async () => {
    const dir = secretLaunchDirPath(OPENRIG_HOME);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    const kept = path.join(dir, "kept");
    fs.writeFileSync(kept, "", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
    try {
      expect((daemon.deps.tmuxAdapter as unknown as { secretLaunchDir?: string }).secretLaunchDir).toBeUndefined();
      expect(fs.existsSync(kept)).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/mode 0755, not 0700/);
    } finally {
      warn.mockRestore();
      fs.chmodSync(dir, 0o700);
      fs.rmSync(kept, { force: true });
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });

  for (const host of ["linux", "darwin"] as const) {
    it(`runs tmux without a shell on ${host}, a client spawned per command unless control mode is asked for`, async () => {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      for (const value of [undefined, "0", "true"]) {
        vi.stubEnv("OPENRIG_TMUX_CONTROL", value);
        const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
        try {
          expect(argvExecOf(daemon.deps.tmuxAdapter), String(value)).toBe(execArgvCommand);
        } finally {
          daemon.eventLoopMonitor.stop();
          daemon.db.close();
        }
      }
    });
  }

  it("OPENRIG_TMUX_CONTROL=1 drives tmux through its control client on linux and darwin, never on Windows", async () => {
    vi.stubEnv("OPENRIG_TMUX_CONTROL", "1");
    for (const host of ["linux", "darwin", "win32"] as const) {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
      try {
        const exec = argvExecOf(daemon.deps.tmuxAdapter) as (ArgvExecFn & { close?: () => Promise<void> }) | undefined;
        if (host === "win32") {
          expect(exec, host).toBe(execArgvCommand);
        } else {
          expect(exec, host).not.toBe(execArgvCommand);
          expect(typeof exec?.close, host).toBe("function");
        }
        await daemon.deps.tmuxAdapter.closeControlClient();
      } finally {
        daemon.eventLoopMonitor.stop();
        daemon.db.close();
      }
    }
  });

  it("OPENRIG_TMUX_SHELL=1 keeps tmux on the shell path on linux, and is ignored on Windows", async () => {
    vi.stubEnv("OPENRIG_TMUX_SHELL", "1");
    for (const [host, expected] of [["linux", undefined], ["win32", execArgvCommand]] as const) {
      Object.defineProperty(process, "platform", { ...platform, value: host });
      const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory });
      try {
        expect(argvExecOf(daemon.deps.tmuxAdapter), host).toBe(expected);
      } finally {
        daemon.eventLoopMonitor.stop();
        daemon.db.close();
      }
    }
  });

  it("keeps an injected string exec on the shell path, so its fake sees every command", async () => {
    const tmuxExec: ExecFn = async () => "";
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec });
    try {
      expect(argvExecOf(daemon.deps.tmuxAdapter)).toBeUndefined();
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  });
});
