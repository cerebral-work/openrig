// Teardown for a test's private tmux server (`tmux -L <name>`). tmux (3.4, measured 2026-10-18) leaves its socket file
// behind even after kill-server, so every run added one file to the socket directory: about 3,500 accumulated
// (linear-pending item 44). Call this from afterAll, afterEach or finally, so it also runs when the test fails.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pexec = promisify(execFile);
/** Test socket names only (the CLI's terminal-window tests use ws-/wv-); "default", the live fleet's socket, never matches. */
const TEST_SOCKET = /^(openrig|silent|ws|wv)-[\w-]+$/;

/** The line that turns bash history off for a test shell: put it first in any rc a test pane reads (`--rcfile`). A pane
 *  started with `--norc` passes `+o history` instead. */
export const NO_SHELL_HISTORY = "unset HISTFILE\n";

/**
 * A scratch root for a real-tmux test, used as the panes' HOME. A dying interactive bash writes `.bash_history` into HOME
 * on the SIGHUP from kill-server, after the test has moved on to removing the root: the late entry that failed the
 * full-suite job with ENOTEMPTY (2026-10-18). This root's `.bashrc` (interactive) and `.bash_profile` (login) turn history
 * off, so a default-shell pane never writes one; allow-list mode can't strip it, because it runs inside the shell.
 */
export function createTmuxTestRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  noShellHistory(root);
  return root;
}

/** Write `home`'s bash startup files so its interactive (`.bashrc`) and login (`.bash_profile`) shells keep no history. */
export function noShellHistory(home: string): void {
  for (const file of [".bashrc", ".bash_profile"]) writeFileSync(join(home, file), NO_SHELL_HISTORY);
}

/**
 * Remove a test's scratch root after its tmux server was told to stop. A pane's process can still add an entry for a
 * moment after kill-server. On Node 22, rmSync's own maxRetries retries only the final rmdir and never lists the
 * directory again, so it can't recover; this re-runs the whole removal, which lists again, up to 10 times 100 ms apart,
 * then throws naming what is left (names only, never contents). `remove` is for tests.
 */
export function removeTmuxTestRoot(root: string, remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })): void {
  let last: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      remove(root);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY") throw error;
      last = error;
      const until = Date.now() + 100;
      while (Date.now() < until) { /* a sync wait: callers tear down synchronously */ }
    }
  }
  let left: string[] = [];
  try { left = readdirSync(root); } catch { /* gone after all */ }
  throw new Error(`could not remove the test root ${root} after 10 attempts (${(last as Error).message}); left: ${left.join(", ") || "(nothing)"}`);
}

/** Where tmux puts a `-L` socket: `$TMUX_TMPDIR` (or `/tmp`), then `tmux-<uid>`. */
export function tmuxTestSocketPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env["TMUX_TMPDIR"] || "/tmp", `tmux-${process.getuid!()}`, name);
}

/**
 * Stop the named test server, if `killServer`, and unlink its socket once nothing answers on it. A file whose rule is
 * "teardown by session name, never kill-server" passes `killServer: false`: its server exits with its last session,
 * and a server that still answers is left with its socket, because unlinking a live server's socket would orphan it.
 * Every tmux call names the socket with `-L` and drops `$TMUX`, so it can only reach this test's server.
 */
export async function releaseTmuxTestSocket(name: string, opts: { killServer: boolean }, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!TEST_SOCKET.test(name)) throw new Error(`not a test tmux socket: ${name}`);
  const clean: NodeJS.ProcessEnv = { ...env };
  delete clean["TMUX"];
  const tmux = (...args: string[]) => pexec("tmux", ["-L", name, ...args], { env: clean, timeout: 5000 });
  const answers = () => tmux("list-sessions").then(() => true, () => false);
  if (opts.killServer) await tmux("kill-server").catch(() => {});
  // A server exits a moment after its last session or kill-server; wait briefly before deciding it is still live.
  for (let i = 0; i < 20 && await answers(); i++) await new Promise((r) => setTimeout(r, 50));
  if (await answers()) return;
  const path = tmuxTestSocketPath(name, env);
  try {
    if (lstatSync(path).isSocket()) rmSync(path, { force: true });
  } catch {
    // already gone
  }
}
