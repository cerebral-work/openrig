// A cosmetic tmux hook that fails (here session-created, as the estate's glance singleton did) puts a
// fresh pane in view-mode. While a read-only client is attached, Enter into that pane then fails with
// "client is read-only", and the launch fails. The fresh-shell handshake leaves the mode first.
// Real tmux with a private socket; see estate-onboarding/factories-20261017/vilicus/LAUNCH-FAILURE.md.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";

let tools = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); execFileSync("script", ["--version"], { stdio: "ignore" }); tools = true; } catch { /* optional */ }

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!tools || process.platform !== "linux")("fresh-shell launch into a pane a failing hook left in view-mode", () => {
  it("leaves the mode and launches, with a read-only client attached", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pane-mode-"));
    const socket = path.join(root, "s");
    const marker = path.join(root, "launched");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/bash", MOTD_SHOWN: "update-motd" };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
    const adapter = new TmuxAdapter(async (cmd) => {
      if (!cmd.startsWith("tmux ")) throw new Error("unexpected fixture command");
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout;
    }, undefined, async (argv) => {
      if (argv[0] !== "tmux") throw new Error("unexpected fixture command");
      return (await run("tmux", ["-S", socket, "-f", "/dev/null", ...argv.slice(1)], { env, timeout: 8000 })).stdout;
    }, { handshake: true });
    let client: ChildProcess | null = null;
    try {
      await tm(["new-session", "-d", "-s", "anchor"]);
      await tm(["set-option", "-g", "default-command", "bash --noprofile --norc"]);
      await tm(["set-hook", "-g", "session-created", `run-shell -b "sh -c 'echo already running >&2; exit 1'"`]);

      expect(await adapter.createSession("seat", root)).toEqual({ ok: true });
      await until(async () => (await tm(["display-message", "-p", "-t", "=seat:", "#{pane_mode}"])).trim() === "view-mode", "the hook's view-mode");

      // The read-only client is what turns a mode keypress into a failure.
      client = spawn("script", ["-qfc", `tmux -S ${q(socket)} -f /dev/null attach -r -t anchor`, "/dev/null"], { env, stdio: ["pipe", "ignore", "ignore"] });
      await until(async () => (await tm(["list-clients", "-F", "#{client_readonly}"]).catch(() => "")).trim() === "1", "the read-only client");

      const result = await adapter.sendShellCommand("seat", `touch ${q(marker)}`);
      expect(result).toEqual({ ok: true });
      expect((await tm(["display-message", "-p", "-t", "=seat:", "#{pane_in_mode}"])).trim()).toBe("0");
      await until(async () => fs.existsSync(marker), "the launched command");
    } finally {
      await tm(["kill-server"]).catch(() => {});
      client?.kill("SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
