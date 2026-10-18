// Teardown for a test's private tmux server (`tmux -L <name>`). tmux (3.4, measured 2026-10-18) leaves its socket file
// behind even after kill-server, so every run added one file to the socket directory: about 3,500 accumulated
// (linear-pending item 44). Call this from afterAll, afterEach or finally, so it also runs when the test fails.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

const pexec = promisify(execFile);
/** Test socket names only (the CLI's terminal-window tests use ws-/wv-); "default", the live fleet's socket, never matches. */
const TEST_SOCKET = /^(openrig|silent|ws|wv)-[\w-]+$/;

/**
 * Remove a test's scratch root after its tmux server was told to stop. The server's panes (a shell, a stub runtime) can
 * still be writing into the root for a moment after kill-server, and a plain recursive rmSync then fails with ENOTEMPTY
 * (ubuntu-latest, 2026-10-18). Node's rmSync retries ENOTEMPTY and EBUSY when it is given maxRetries.
 */
export function removeTmuxTestRoot(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
