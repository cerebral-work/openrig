// Private tmux servers in tests (`-L <name>`) left their socket file behind: tmux 3.4 does not unlink it even after
// kill-server, so every run added one file to the socket directory (about 3,500 by 2026-10-18). The shared teardown
// stops the server where the file allows that, and unlinks the socket once nothing answers on it, also when the
// test failed. It runs against real tmux and skips where tmux is missing.
import { describe, it, expect, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseTmuxTestSocket, removeTmuxTestRoot, tmuxTestSocketPath } from "./helpers/tmux-test-socket.js";

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
  // The race it absorbs (a pane still writing into the root after kill-server, so a plain recursive rmSync reads
  // ENOTEMPTY) was seen on ubuntu-latest and did not reproduce locally; this pins the removal itself.
  it("removes a nested root, and a root already gone is no error", () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-test-root-"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "f"), "x");
    removeTmuxTestRoot(root);
    expect(existsSync(root)).toBe(false);
    expect(() => removeTmuxTestRoot(root)).not.toThrow();
  });
});
