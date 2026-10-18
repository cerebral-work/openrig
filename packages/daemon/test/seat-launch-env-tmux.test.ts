// A tmux server recreated from a herdr pane carries every HERDR_* name in its global environment.
// This runs a private tmux server that does, launches through the real adapter, and reads what the
// pane process was actually given: no HERDR_* name, while OpenRig metadata and TMUX reach it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

const HERDR_PANE = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w4F:p1",
  HERDR_SESSION: "estate",
  HERDR_SOCKET_PATH: "/parent/herdr.sock",
  HERDR_BIN_PATH: "/parent/herdr",
};

async function paneEnviron(tm: (args: string[]) => Promise<string>, target: string): Promise<Record<string, string>> {
  for (let i = 0; i < 200; i++) {
    const pid = (await tm(["display-message", "-p", "-t", target, "#{pane_pid}"])).trim();
    const file = `/proc/${pid}/environ`;
    if (/^\d+$/.test(pid) && fs.existsSync(file)) {
      const env: Record<string, string> = {};
      for (const entry of fs.readFileSync(file, "utf8").split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      if (env.TMUX) return env;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no readable pane environment for ${target}`);
}

describe.skipIf(!hasTmux || process.platform !== "linux")("seat launch environment on a tmux server started from a herdr pane", () => {
  it.each(["fresh", "probe"] as const)("a %s launch gets no HERDR_* name and keeps OpenRig metadata and TMUX", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-env-"));
    const socket = path.join(root, "tmux");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh", OPENRIG_FIXTURE: "kept", ...HERDR_PANE };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
    const adapter = new TmuxAdapter(async (cmd) => {
      if (!cmd.startsWith("tmux ")) throw new Error("unexpected fixture command");
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout;
    });
    try {
      // The server's global environment is the herdr pane's.
      await tm(["new-session", "-d", "-s", "anchor"]);
      expect(await tm(["show-environment", "-g", "HERDR_SOCKET_PATH"])).toContain("/parent/herdr.sock");

      const name = kind === "fresh" ? "dev@rig" : "rigged-refresh-dev";
      const result = kind === "fresh"
        ? await adapter.createSession(name, root, { OPENRIG_NODE_ID: "n1" })
        : await adapter.createProbeSession(name, root);
      expect(result).toEqual({ ok: true });

      const seat = await paneEnviron(tm, `=${name}:`);
      expect(Object.keys(seat).filter((k) => k.startsWith("HERDR_"))).toEqual([]);
      expect(seat.OPENRIG_FIXTURE).toBe("kept");
      expect(seat.TMUX).toBeTruthy();
      if (kind === "fresh") expect(seat.OPENRIG_NODE_ID).toBe("n1");
    } finally {
      await tm(["kill-server"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
