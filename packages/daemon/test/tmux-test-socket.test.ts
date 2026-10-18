// Private tmux servers in tests (`-L <name>`) left their socket file behind: tmux 3.4 does not unlink it even after
// kill-server, so every run added one file to the socket directory (about 3,500 by 2026-10-18). The shared teardown
// stops the server where the file allows that, and unlinks the socket once nothing answers on it, also when the
// test failed. It runs against real tmux and skips where tmux is missing.
import { describe, it, expect, afterAll, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const hasTmux = () => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } };
import { createTmuxTestRoot, NO_SHELL_HISTORY, releaseTmuxTestSocket, removeTmuxTestRoot, tmuxTestSocketPath } from "./helpers/tmux-test-socket.js";

const pexec = promisify(execFile);
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
delete cleanEnv["TMUX"];
const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; } })();
const tmux = (name: string, ...args: string[]) => pexec("tmux", ["-L", name, "-f", "/dev/null", ...args], { env: cleanEnv, timeout: 5000 });
const answers = (name: string) => tmux(name, "list-sessions").then(() => true, () => false);
const name = (tag: string) => `openrig-sockhelper-${tag}-${process.pid}`;
const started: string[] = [];
const start = async (tag: string) => {
  const sock = name(tag);
  started.push(sock);
  await tmux(sock, "new-session", "-d", "-s", "s", "sleep 60");
  expect(existsSync(tmuxTestSocketPath(sock))).toBe(true);
  return sock;
};

afterAll(async () => {
  for (const sock of started) await releaseTmuxTestSocket(sock, { killServer: true });
});

describe("releaseTmuxTestSocket: a test's private tmux server leaves no socket file (linear-pending item 44)", () => {
  it.runIf(available)("stops the server and removes its socket, even when the test body throws", async () => {
    const sock = await start("throws");
    await expect((async () => {
      try { throw new Error("the test failed"); } finally { await releaseTmuxTestSocket(sock, { killServer: true }); }
    })()).rejects.toThrow("the test failed");
    expect(await answers(sock)).toBe(false);
    expect(existsSync(tmuxTestSocketPath(sock))).toBe(false);
  });

  it.runIf(available)("without killServer, removes the socket once the server has exited by session name", async () => {
    const sock = await start("byname");
    await tmux(sock, "kill-session", "-t", "s");
    await releaseTmuxTestSocket(sock, { killServer: false });
    expect(existsSync(tmuxTestSocketPath(sock))).toBe(false);
  });

  it.runIf(available)("without killServer, leaves a server that still answers, and its socket, alone", async () => {
    const sock = await start("live");
    await releaseTmuxTestSocket(sock, { killServer: false });
    expect(await answers(sock)).toBe(true); // unlinking a live server's socket would orphan it
    expect(existsSync(tmuxTestSocketPath(sock))).toBe(true);
  });

  it("refuses any name that is not a test socket, and never touches default", async () => {
    for (const bad of ["default", "openrig", "../default", "fleet-socket"]) {
      await expect(releaseTmuxTestSocket(bad, { killServer: true })).rejects.toThrow("not a test tmux socket");
    }
  });
});

describe("removeTmuxTestRoot", () => {
  it("removes a nested root, and a root already gone is no error", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-test-root-"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f"), "x");
    removeTmuxTestRoot(root);
    expect(existsSync(root)).toBe(false);
    expect(() => removeTmuxTestRoot(root)).not.toThrow();
  });

  // A late writer, made deterministic: the first removal attempt meets an entry added after it listed the directory, and
  // fails as Node 22's rmSync does (ENOTEMPTY from rmdir, whatever its maxRetries). The next whole removal lists again.
  const enotempty = () => Object.assign(new Error("ENOTEMPTY: directory not empty, rmdir"), { code: "ENOTEMPTY" });
  it("re-runs the whole removal after a late entry, so the root goes", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-test-root-"));
    let calls = 0;
    removeTmuxTestRoot(root, (path) => {
      if (calls++ === 0) { writeFileSync(join(path, ".bash_history"), "late"); throw enotempty(); }
      rmSync(path, { recursive: true, force: true });
    });
    expect(calls).toBe(2);
    expect(existsSync(root)).toBe(false);
  });

  it("gives up after 10 attempts, naming what is left and never its contents", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-test-root-"));
    writeFileSync(join(root, ".bash_history"), "SENTINEL-CONTENT");
    let calls = 0;
    expect(() => removeTmuxTestRoot(root, () => { calls++; throw enotempty(); }))
      .toThrow(/after 10 attempts.*left: \.bash_history$/);
    expect(calls).toBe(10);
    try { removeTmuxTestRoot(root, () => { throw enotempty(); }); } catch (error) { expect(String(error)).not.toContain("SENTINEL-CONTENT"); }
    rmSync(root, { recursive: true, force: true });
  });

  // Review r1 S1: a test with fake timers (vi.useFakeTimers freezes Date) still gets its 100 ms between attempts.
  it("waits for real between attempts under fake timers", { timeout: 5_000 }, () => {
    const before = Date.now(); // real time: taken before the timers are faked
    vi.useFakeTimers();
    try {
      const root = mkdtempSync(join(tmpdir(), "tmux-test-root-"));
      let calls = 0;
      removeTmuxTestRoot(root, (path) => { if (calls++ === 0) throw enotempty(); rmSync(path, { recursive: true, force: true }); });
      expect(calls).toBe(2);
      expect(existsSync(root)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // Review r1 on #47: the one retry waited a real ~100 ms, not zero.
    expect(Date.now() - before).toBeGreaterThanOrEqual(95);
  });

  it("rethrows any other error at once", () => {
    let calls = 0;
    expect(() => removeTmuxTestRoot("/nowhere", () => { calls++; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })).toThrow("EACCES");
    expect(calls).toBe(1);
  });
});

describe("createTmuxTestRoot", () => {
  it("turns bash history off for the root's interactive and login shells", () => {
    const root = createTmuxTestRoot("tmux-test-root-");
    expect(readFileSync(join(root, ".bashrc"), "utf8")).toBe(NO_SHELL_HISTORY);
    expect(readFileSync(join(root, ".bash_profile"), "utf8")).toBe(NO_SHELL_HISTORY);
    removeTmuxTestRoot(root);
  });

  // The late writer itself, on a real server: a default-shell (login bash) pane with HOME in the root runs a command, then
  // kill-server. A plain root gets .bash_history after kill-server returns; a createTmuxTestRoot root never does.
  it.skipIf(!hasTmux() || process.platform !== "linux")("a login-shell pane writes no .bash_history after kill-server; a plain root does (control)", async () => {
    const sawHistory = async (root: string) => {
      const socket = join(root, "s");
      const env = { HOME: root, PATH: process.env.PATH!, TERM: "xterm-256color", SHELL: "/bin/bash" };
      const tm = (args: string[]) => pexec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 });
      try {
        await tm(["new-session", "-d", "-s", "probe"]);
        await new Promise((r) => setTimeout(r, 400));
        await tm(["send-keys", "-t", "probe", "echo history-probe", "Enter"]);
        await new Promise((r) => setTimeout(r, 400));
        await tm(["kill-server"]).catch(() => {});
        await new Promise((r) => setTimeout(r, 500));
        return existsSync(join(root, ".bash_history"));
      } finally {
        await tm(["kill-server"]).catch(() => {});
        removeTmuxTestRoot(root);
      }
    };
    expect(await sawHistory(createTmuxTestRoot("tmux-test-root-"))).toBe(false);
    expect(await sawHistory(mkdtempSync(join(tmpdir(), "tmux-test-root-plain-")))).toBe(true);
  }, 20_000);
});
