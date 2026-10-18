// Runs as a child of fixture-home-cleanup.test.ts: loads the shared vitest setup in a plain Node process,
// prints the homes it ended up with, and exits.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import "../../../../test/hermetic-env.setup.js";

// What a test does: make a temp dir the usual way, with os.tmpdir().
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-scratch-"));
fs.writeFileSync(path.join(scratch, "file"), "x");
// With "tmux", also start a private tmux server whose socket is inside the worker's TMPDIR, as the scenario
// scaffold does (<root>/tmux.sock), and leave it running for the worker's exit to deal with.
let tmux: { socket: string; pid: number } | undefined;
if (process.argv.includes("tmux")) {
  const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "openrig-scenario-")), "tmux.sock");
  const env = { ...process.env };
  delete env["TMUX"];
  execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "s", "sleep 300"], { env });
  const pid = Number(execFileSync("tmux", ["-S", socket, "display-message", "-p", "#{pid}"], { env, encoding: "utf-8" }).trim());
  tmux = { socket, pid };
}
console.log(JSON.stringify({ openrigHome: process.env["OPENRIG_HOME"], home: process.env["HOME"], tmpdir: os.tmpdir(), scratch, tmux }));
// With "wait", stay alive for the test to signal: a vitest worker is ended with SIGTERM while it is running.
if (process.argv.includes("wait")) setInterval(() => {}, 1000);
