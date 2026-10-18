// Spec 0013 item 9 (security): no secret value on a tmux argv. A tmux server keeps the argv of the command that
// started it, so `ps` shows it for the server's whole life; a client shows its argv while it runs. The activity-hook
// token used to ride in every launch as `-e OPENRIG_ACTIVITY_HOOK_TOKEN=<value>`. Sentinels only: no real value.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { buildLaunchSessionEnv } from "../src/domain/launch-session-env.js";
import { resolveStubActivityEndpoint } from "../src/adapters/stub-runner.js";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { SEAT_ENV_SECRET_NAME } from "../src/domain/seat-launch-env-filter.js";
import { createTmuxTestRoot, removeTmuxTestRoot } from "./helpers/tmux-test-socket.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";
const sentinel = () => `sentinel-${randomBytes(8).toString("hex")}`;

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

/** How many live processes carry `needle` in their argv. Reads /proc; never prints an argv. */
function processesWithArgv(needle: string): number {
  let hits = 0;
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try { if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle)) hits++; } catch { /* exited */ }
  }
  return hits;
}

function launchEnv(token: string, home: string): Record<string, string> {
  const env = buildLaunchSessionEnv({
    path: process.env.PATH, openRigHome: home, port: "17534", host: "127.0.0.1",
    activityEndpoint: { baseUrl: "http://127.0.0.1:17534", token }, providerAuthEnv: {},
    home, user: "seat", logname: "seat", codexHome: undefined,
  });
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

describe("no secret value on a tmux argv (spec 0013 item 9)", () => {
  it("the launch env carries no activity-hook token", () => {
    const token = sentinel();
    const env = launchEnv(token, "/home/seat/.openrig");
    expect(Object.keys(env)).not.toContain("OPENRIG_ACTIVITY_HOOK_TOKEN");
    expect(Object.values(env)).not.toContain(token);
  });

  it.skipIf(!hasTmux || process.platform !== "linux")("a seat launched as the daemon does leaves the token on no tmux argv, server or client", async () => {
    const root = createTmuxTestRoot("seat-argv-");
    const socket = path.join(root, "tmux");
    const token = sentinel();
    const ran: string[] = [];
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/sh" };
    const adapter = new TmuxAdapter(async (cmd) => {
      ran.push(cmd);
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout;
    });
    try {
      // No anchor session first: the daemon's own command starts the server, as it does in production.
      const created = await adapter.createSession("dev@rig", root, { OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "dev@rig", ...launchEnv(token, root) });
      expect(created.ok).toBe(true);
      expect(ran.filter((cmd) => cmd.includes(token))).toEqual([]);
      expect(processesWithArgv(socket)).toBeGreaterThan(0); // control: the server for this socket is running
      expect(processesWithArgv(token)).toBe(0);
    } finally {
      await run("tmux", ["-S", socket, "kill-server"], { env, timeout: 8000 }).catch(() => {});
      removeTmuxTestRoot(root);
    }
  }, 30_000);

  it("createSession and respawnPane refuse a secret-named variable before any tmux command, naming it without its value", async () => {
    const value = sentinel();
    const ran: string[] = [];
    const adapter = new TmuxAdapter(async (cmd) => { ran.push(cmd); return ""; });
    const created = await adapter.createSession("dev@rig", "/tmp", { OPENRIG_NODE_ID: "n1", EXAMPLE_PROVIDER_API_KEY: value });
    expect(created).toMatchObject({ ok: false, code: "secret_on_argv_refused" });
    expect(created.ok ? "" : created.message).toContain("EXAMPLE_PROVIDER_API_KEY");
    expect(created.ok ? "" : created.message).not.toContain(value);
    const respawned = await adapter.respawnPane("%1", "/bin/sh", { env: { SEAT_ACCESS_TOKEN: value } });
    expect(respawned).toMatchObject({ ok: false, code: "secret_on_argv_refused" });
    expect(respawned.ok ? "" : respawned.message).toContain("SEAT_ACCESS_TOKEN");
    expect(ran.filter((cmd) => /new-session|respawn-pane/.test(cmd))).toEqual([]);
    expect(ran.filter((cmd) => cmd.includes(value))).toEqual([]);
    // OPENRIG_SEAT_ENV_KEYS matches the name rule but lists declared variable names: it is never refused.
    expect(await adapter.createSession("dev@rig", "/tmp", { OPENRIG_NODE_ID: "n1", OPENRIG_SEAT_ENV_KEYS: "SHARED,MEMBER_ONLY" })).toMatchObject({ ok: true });
    // Review r2 LOW: the exemption holds only for a value shaped as a list of names; anything else is refused like any
    // secret-named variable, without its value in the message.
    const shaped = await adapter.createSession("dev@rig", "/tmp", { OPENRIG_NODE_ID: "n1", OPENRIG_SEAT_ENV_KEYS: value });
    expect(shaped).toMatchObject({ ok: false, code: "secret_on_argv_refused" });
    expect(shaped.ok ? "" : shaped.message).not.toContain(value);
  });

  // Review r2 R1 on #35: the managed Claude launch forwards session variables by expansion onto /usr/bin/env -i's
  // argv. `sh -x` traces the exact words env receives after expansion, so this is a deterministic argv record (spec
  // 0017: /proc sampling can miss a short-lived process). Red first against the base shape, which put the token in
  // the launch env.
  it.skipIf(process.platform === "win32").each([
    ["head: the real builder", false],
    ["base shape: the token in the launch env", true],
  ] as const)("the managed launch's env -i argv holds no token and no secret-named value (%s)", async (_label, baseShape) => {
    const root = createTmuxTestRoot("managed-argv-");
    try {
      const bin = path.join(root, "bin"); const cwd = path.join(root, "work");
      for (const dir of [bin, cwd]) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\nif [ \"$1\" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: \"auto\", \"default\")'; exit 0; fi\nexit 0\n", { mode: 0o700 });
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT); CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
        CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
        CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
        INSERT INTO rigs VALUES ('rig', NULL); INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', '${cwd}', NULL);
        INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1);`);
      const token = sentinel();
      const sessionEnv = { ...launchEnv(token, root), PATH: `${bin}:/usr/bin:/bin`,
        ...(baseShape ? { OPENRIG_ACTIVITY_HOOK_TOKEN: token } : {}) };
      const command = (await new ClaudeManagedLaunch(db, sessionEnv, {}).prepare({ nodeId: "node", session: "seat@rig", pane: "%1" }, "auto"))
        .command(["--permission-mode", "auto"]);
      db.close();
      // The pane shell's environment: in the base shape tmux put the token there; at head it never does.
      const { stderr } = await run("/bin/sh", ["-x", "-c", command], { env: { PATH: "/usr/bin:/bin", ...sessionEnv } }).catch((err: { stderr?: string }) => ({ stderr: err.stderr ?? "" }));
      const envLine = stderr.split("\n").find((line) => line.includes("/usr/bin/env -i")) ?? "";
      expect(envLine).not.toBe(""); // control: the trace caught env -i's argv
      const secretAssignments = (envLine.match(/\b([A-Za-z_][A-Za-z0-9_]*)=/g) ?? []).map((m) => m.slice(0, -1)).filter((name) => SEAT_ENV_SECRET_NAME.test(name));
      if (baseShape) {
        expect(envLine).toContain(token);
      } else {
        expect(envLine).not.toContain(token);
        expect(secretAssignments).toEqual([]);
      }
    } finally {
      removeTmuxTestRoot(root);
    }
  });

  it("a seat with no token in its env reads it from the daemon's 0600 activity endpoint file", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-endpoint-"));
    try {
      const token = sentinel();
      fs.writeFileSync(path.join(home, "activity-endpoint.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:17534", token }), { mode: 0o600 });
      expect(resolveStubActivityEndpoint({ OPENRIG_HOME: home, OPENRIG_URL: "http://127.0.0.1:17534" })).toEqual({ baseUrl: "http://127.0.0.1:17534", token });
    } finally {
      removeTmuxTestRoot(home);
    }
  });
});
