// Spec 0013 item 9, review r2 F1 on #35: a handover must refuse a secret-named successor env BEFORE the cutover. The
// respawn guard refuses it anyway, but by then the retiree has been terminated, so the seat would be left dead.
// Real tmux on a private socket, the real TmuxAdapter and SuccessorSessionLauncher; names only, no secret values.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { createTmuxTestRoot, removeTmuxTestRoot } from "./helpers/tmux-test-socket.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

describe.skipIf(!hasTmux || process.platform !== "linux")("handover with a secret-named successor env (review r2 F1 on #35)", () => {
  it.each([
    ["EXAMPLE_API_KEY", true],
    ["SAFE_SETTING", false],
    // Spec 0017 item 4: exempt by exact name, so the launch guard lets it through.
    ["TOKENIZERS_PARALLELISM", false],
  ] as const)("seat env %s: refused before the cutover leaves the retiree running (%s)", async (name, refused) => {
    const root = createTmuxTestRoot("succ-secret-");
    const socket = path.join(root, "tmux");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh" };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout.trim();
    const adapter = new TmuxAdapter(async (cmd) =>
      (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout);
    const db = createFullTestDb();
    try {
      await tm(["new-session", "-d", "-s", "dev-impl@rig", "sleep 300"]);
      const before = await tm(["display-message", "-p", "-t", "=dev-impl@rig:", "#{pane_pid}"]);
      const harness = { runtime: "codex", launchHarness: vi.fn(async () => ({ ok: true })), checkReady: vi.fn(async () => ({ ready: true })) };
      const launcher = new SuccessorSessionLauncher(adapter, new DiscoveryRepository(db), {
        sessionEnv: { HOME: root }, newId: () => "01SUCC", runtimeAdapters: { codex: harness as unknown as RuntimeAdapter },
        readinessTimeoutMs: 50, sleep: async () => {}, exitPollMs: 20, exitTimeoutMs: 2000,
      });
      const onReplacementStarted = vi.fn();
      const result = await launcher.createSuccessor({
        node: { id: "node-1", runtime: "codex", cwd: root, seatEnv: { [name]: "1" } },
        departingSessionName: "dev-impl@rig", onReplacementStarted,
      });
      const after = await tm(["display-message", "-p", "-t", "=dev-impl@rig:", "#{pane_pid}"]);
      const dead = await tm(["display-message", "-p", "-t", "=dev-impl@rig:", "#{pane_dead}"]);
      if (refused) {
        expect(result).toMatchObject({ ok: false, code: "secret_on_argv_refused", replacementStarted: false });
        expect(result.ok ? "" : result.message).toContain(name);
        expect(after).toBe(before); // the retiree still runs, untouched
        expect(dead).toBe("0");
        expect(onReplacementStarted).not.toHaveBeenCalled();
      } else {
        // The control: the cutover runs, and the pane is respawned with a new process.
        expect(onReplacementStarted).toHaveBeenCalled();
        expect(after).not.toBe(before);
        expect(dead).toBe("0");
      }
    } finally {
      db.close();
      await tm(["kill-server"]).catch(() => {});
      removeTmuxTestRoot(root);
    }
  }, 30_000);
});
