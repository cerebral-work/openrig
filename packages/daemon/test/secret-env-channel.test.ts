// Spec 0017 items 1 to 3 (SEC-183 part 2): a daemon-origin secret-named value reaches the launched runtime only through
// its staged script, never through any argv, the tmux session or global environment, or the pane shell. Sentinel values
// only: nothing here reads an operator's environment.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TmuxAdapter, defaultTmuxFileOps, isStagedSendScriptPath, type TmuxFileOps } from "../src/adapters/tmux.js";
import { ensureSecretLaunchDir, secretLaunchDirPath } from "../src/domain/secret-launch-dir.js";

const exec = promisify(execFile);
const SENTINEL = "sentinel-sec183-9d41c7e2";
const NAME = "OPENRIG_ACTIVITY_HOOK_TOKEN";
const QUOTED = "it's-a-sentinel-sec183-quote";

/** REQ-0017-10: every line that holds `value` is exactly one `export NAME='…'` with single-quote escaping, and nothing
 *  else: no command substitution and no external command on that line. */
function exportLineViolations(script: string, value: string): string[] {
  const quoted = `'${value.replace(/'/g, "'\\''")}'`;
  return script.split("\n").filter((line) => line.includes(value) || line.includes(quoted))
    .filter((line) => !new RegExp(`^export [A-Za-z_][A-Za-z0-9_]*=${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(line));
}

interface Fixture {
  adapter: TmuxAdapter;
  argv: string[][];
  writes: Map<string, string>;
  dir: string;
  home: string;
  failPaste?: boolean;
}

function fakeAdapter(home: string, opts: { scoped?: boolean; dir?: string | null } = {}): Fixture {
  const argv: string[][] = [];
  const writes = new Map<string, string>();
  const real = defaultTmuxFileOps();
  let n = 0;
  const fixture = {} as Fixture;
  const files: TmuxFileOps = {
    writeFile: async (p, content, options) => { writes.set(p, content); await real.writeFile(p, content, options); },
    unlink: (p) => real.unlink(p),
    tmpName: () => path.join(home, `openrig-tmux-send-${process.pid}-00000000-0000-4000-8000-${String(++n).padStart(12, "0")}.txt`),
    bufferName: () => `buffer${n}`,
  };
  const respond = async (args: string[]): Promise<string> => {
    argv.push(args);
    if (fixture.failPaste && args[1] === "paste-buffer") throw new Error("Command failed: tmux paste-buffer\nsynthetic paste failure");
    if (args.includes("default-shell")) return "/bin/bash";
    if (args[1] === "new-session" || args[1] === "source-file" && readFileSync(args.at(-1)!, "utf8").startsWith("new-session")) return "%7\n";
    if (args[1] === "display-message" && args.includes("#{session_name}")) return "seat@rig\n";
    if (args[1] === "display-message" && args.includes("#{pane_current_command}")) return "bash\n";
    if (args[1] === "list-panes") return "%7|0|/w|80|24|1\n";
    return "";
  };
  const adapter = new TmuxAdapter(async (cmd) => respond(["tmux", cmd]), files, respond);
  adapter.launchEnvironment = () => ({ inheritTmuxEnvironment: !opts.scoped, env: { PATH: "/bin", [NAME]: SENTINEL } });
  const dir = opts.dir === undefined ? secretLaunchDirPath(home) : opts.dir ?? "";
  if (opts.dir !== null) { ensureSecretLaunchDir(dir); adapter.setSecretLaunchDir(dir); }
  Object.assign(fixture, { adapter, argv, writes, dir, home });
  return fixture;
}

const launchEnv = { OPENRIG_NODE_ID: "node-1", OPENRIG_SESSION_NAME: "seat@rig", [NAME]: SENTINEL, PLAIN: "visible" };
const anyArgvHolds = (f: Fixture, value = SENTINEL) => f.argv.some((args) => args.some((arg) => arg.includes(value)));
const stagedScripts = (f: Fixture) => [...f.writes.entries()].filter(([p]) => p.startsWith(f.dir + path.sep));

describe.skipIf(process.platform === "win32")("secret env channel, recorded execs (spec 0017)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "openrig-sec183-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  for (const scoped of [false, true]) {
    it(`REQ-0017-16/03: createSession (scoped=${scoped}) leaves the value out of -e, the source-file config and the scoped file`, async () => {
      const f = fakeAdapter(home, { scoped });
      const created = await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
      expect(created.ok).toBe(true);
      expect(anyArgvHolds(f)).toBe(false);
      expect([...f.writes.values()].some((content) => content.includes(SENTINEL))).toBe(false);
      // The non-secret launch value still reaches tmux.
      expect([...f.writes.values()].some((content) => content.includes("PLAIN=visible"))).toBe(true);
    });
  }

  it("REQ-0017-16: the scoped launch keeps a name tmux's update-environment copies; only daemon-env secrets are left out", async () => {
    const f = fakeAdapter(home, { scoped: true });
    const respond = (f.adapter as unknown as { argvExec: (args: string[]) => Promise<string> }).argvExec;
    (f.adapter as unknown as { argvExec: (args: string[]) => Promise<string> }).argvExec = async (args) =>
      args.includes("update-environment") ? "SSH_AUTH_SOCK GH_TOKEN\n" : respond(args);
    const saved = { sock: process.env.SSH_AUTH_SOCK, gh: process.env.GH_TOKEN };
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sentinel.sock";
    process.env.GH_TOKEN = "operator-copied-sentinel";
    try {
      expect((await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] })).ok).toBe(true);
    } finally {
      for (const [k, v] of [["SSH_AUTH_SOCK", saved.sock], ["GH_TOKEN", saved.gh]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    const scopedFile = [...f.writes.values()].find((c) => c.includes("exec \"$@\""))!;
    expect(scopedFile).toContain("export SSH_AUTH_SOCK='/tmp/agent.sentinel.sock'");
    // An update-environment name is the operator's tmux setting, as before this change; the daemon's own secret is not.
    expect(scopedFile).toContain("export GH_TOKEN=");
    expect(scopedFile.includes(SENTINEL)).toBe(false);
  });

  it("REQ-0017-02/09/10/05: the next staged launch carries the value as an export, behind the tracing guard, in the 0700 directory", async () => {
    const f = fakeAdapter(home);
    expect((await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] })).ok).toBe(true);
    expect((await f.adapter.sendShellCommand("seat@rig", "exec runtime --flag")).ok).toBe(true);
    const scripts = stagedScripts(f);
    expect(scripts).toHaveLength(1);
    const [file, script] = scripts[0]!;
    expect(isStagedSendScriptPath(file)).toBe(true);
    const lines = script.split("\n");
    expect(lines[0]).toBe("{ set +xv; } 2>/dev/null");
    expect(lines[1]).toContain(`/bin/rm -f -- '${file}'`);
    expect(lines).toContain(`export ${NAME}='${SENTINEL}'`);
    expect(lines.indexOf(`export ${NAME}='${SENTINEL}'`)).toBeLessThan(lines.indexOf("exec runtime --flag"));
    expect(exportLineViolations(script, SENTINEL)).toEqual([]);
    expect(anyArgvHolds(f)).toBe(false);
    // Only the path was typed: the pasted invocation's file holds no value.
    expect([...f.writes.entries()].filter(([p]) => !p.startsWith(f.dir)).some(([, c]) => c.includes(SENTINEL))).toBe(false);
  });

  it("REQ-0017-10: a value with a single quote is escaped as '\\'' and still alone on its export line", async () => {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", { ...launchEnv, [NAME]: QUOTED }, { daemonOriginSecrets: [NAME] });
    await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    const [, script] = stagedScripts(f)[0]!;
    expect(script).toContain(`export ${NAME}='it'\\''s-a-sentinel-sec183-quote'`);
    expect(exportLineViolations(script, QUOTED)).toEqual([]);
  });

  it("REQ-0017-10 red: the export-line check rejects a value in a command substitution", () => {
    expect(exportLineViolations(`export ${NAME}="$(printf %s ${SENTINEL})"`, SENTINEL)).toHaveLength(1);
    expect(exportLineViolations(`export ${NAME}='${SENTINEL}'; curl x`, SENTINEL)).toHaveLength(1);
  });

  it("REQ-0017-02: a short Pi command and a typed launch command are staged, never typed, when they carry a value", async () => {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
    expect((await f.adapter.sendShellCommand("seat@rig", "pi", undefined, { stageIfLong: true, execInScript: true })).ok).toBe(true);
    expect(stagedScripts(f)).toHaveLength(1);
    expect((await f.adapter.sendLaunchCommand("seat@rig", "stub-runtime")).ok).toBe(true);
    expect(stagedScripts(f)).toHaveLength(2);
    expect(stagedScripts(f)[1]![1]).toContain("exec stub-runtime");
  });

  it("REQ-0017-16: a respawned pane's session gets the held value for its next launch", async () => {
    const f = fakeAdapter(home);
    expect((await f.adapter.respawnPane("%7", "/bin/bash", { env: launchEnv, daemonOriginSecrets: [NAME] })).ok).toBe(true);
    expect(anyArgvHolds(f)).toBe(false);
    expect([...f.writes.values()].some((content) => content.includes(SENTINEL))).toBe(false);
    await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    expect(stagedScripts(f)[0]![1]).toContain(`export ${NAME}='${SENTINEL}'`);
  });

  it("REQ-0017-17: with no secret-bearing directory, the launch is refused before anything is written or sent, naming only the variable", async () => {
    const f = fakeAdapter(home, { dir: null });
    await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
    const before = { writes: f.writes.size, argv: f.argv.length };
    const sent = await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    expect(sent).toMatchObject({ ok: false, code: "secret_channel_unavailable" });
    expect(!sent.ok && sent.message).toContain(NAME);
    expect(!sent.ok && sent.message).not.toContain(SENTINEL);
    expect(f.writes.size).toBe(before.writes);
    expect(f.argv.slice(before.argv).some((a) => a[1] === "paste-buffer" || a[1] === "load-buffer")).toBe(false);
  });

  it("REQ-0017-11: an unsafe directory refuses the launch and writes nothing", async () => {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
    chmodSync(f.dir, 0o755);
    const before = f.writes.size;
    const sent = await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    expect(sent).toMatchObject({ ok: false, code: "secret_launch_dir_unsafe" });
    expect(!sent.ok && sent.message).toContain("mode 0755");
    expect(f.writes.size).toBe(before);
  });

  it("REQ-0017-07: a failed send deletes the script; an unconsumed one is deleted by the next launch and by killSession", async () => {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
    f.failPaste = true;
    expect((await f.adapter.sendShellCommand("seat@rig", "exec runtime")).ok).toBe(false);
    expect(readdirSync(f.dir)).toEqual([]);
    f.failPaste = false;
    // The fake pane never runs the script, so it stays until the daemon removes it.
    expect((await f.adapter.sendShellCommand("seat@rig", "exec runtime")).ok).toBe(true);
    const first = readdirSync(f.dir);
    expect(first).toHaveLength(1);
    expect(statSync(path.join(f.dir, first[0]!)).mode & 0o777).toBe(0o600);
    expect((await f.adapter.sendShellCommand("seat@rig", "exec runtime")).ok).toBe(true);
    const second = readdirSync(f.dir);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect((await f.adapter.killSession("seat@rig")).ok).toBe(true);
    expect(readdirSync(f.dir)).toEqual([]);
    // A killed session's held values are forgotten: a later launch to the same name carries none.
    await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    expect(stagedScripts(f).at(-1)![0].startsWith(f.dir)).toBe(true);
    expect(readdirSync(f.dir)).toEqual([]);
  });

  it("a launch with no held value keeps today's staging, byte for byte", async () => {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", { OPENRIG_NODE_ID: "node-1", PLAIN: "visible" });
    await f.adapter.sendShellCommand("seat@rig", "exec runtime");
    const staged = [...f.writes.entries()].filter(([p, c]) => isStagedSendScriptPath(p) && c.startsWith("/bin/rm"));
    expect(staged).toHaveLength(1);
    expect(staged[0]![0].startsWith(home + path.sep + "openrig-tmux-send-")).toBe(true);
    expect(staged[0]![1]).toBe(`/bin/rm -f -- '${staged[0]![0]}' 2>/dev/null || command rm -f -- '${staged[0]![0]}' || true\nexec runtime\n`);
  });
});

describe.skipIf(process.platform === "win32")("secret env channel, the staged script under shell tracing (REQ-0017-09)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "openrig-sec183-trace-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  async function stagedScript(): Promise<string> {
    const f = fakeAdapter(home);
    await f.adapter.createSession("seat@rig", "/w", launchEnv, { daemonOriginSecrets: [NAME] });
    await f.adapter.sendShellCommand("seat@rig", "printf done");
    return stagedScripts(f)[0]![1];
  }

  async function hasShell(shell: string): Promise<boolean> {
    try { await exec(shell, ["-c", ":"]); return true; } catch { return false; }
  }

  async function traced(shell: string, flags: string[], script: string): Promise<number> {
    const file = path.join(home, `copy-${Math.random().toString(16).slice(2)}.sh`);
    writeFileSync(file, script, { mode: 0o600 });
    const run = await exec(shell, [...flags, "-c", `( . '${file}' )`], { env: { PATH: "/usr/bin:/bin" } }).catch((e) => e);
    return String(run.stderr ?? "").split(SENTINEL).length - 1;
  }

  const cases: Array<[string, string[]]> = [["bash", ["-x"]], ["bash", ["-v"]], ["zsh", ["-o", "xtrace"]]];
  for (const [shell, flags] of cases) {
    it(`${shell} ${flags.join(" ")}: the guarded script prints no value; without the guard it does`, async () => {
      if (!await hasShell(shell)) return;
      const script = await stagedScript();
      // The copy keeps its self-delete line pointed at the original path, so the copy itself survives the run.
      expect(await traced(shell, flags, script)).toBe(0);
      const unguarded = script.split("\n").slice(1).join("\n");
      expect(await traced(shell, flags, unguarded)).toBeGreaterThanOrEqual(1);
    });
  }

  it("REQ-0017-04: the managed launch's forwarding line and env -u reduction keep the staged value for the exec'd process", async () => {
    const script = await stagedScript();
    const out = path.join(home, "managed-out");
    // The shape of the managed command (claude-managed-launch.ts): a forwarding export, then exec env with only -u removals.
    const managed = `{\nexport ${NAME}="\${${NAME}-}"\nexec /usr/bin/env -u UNRELATED /bin/sh -c 'printf %s "$${NAME}" > "$0"' '${out}'\n}`;
    const file = path.join(home, "managed.sh");
    writeFileSync(file, script.replace("printf done", managed), { mode: 0o600 });
    await exec("/bin/sh", [file], { env: { PATH: "/usr/bin:/bin" } });
    expect(readFileSync(out, "utf8")).toBe(SENTINEL);
    expect(managed.includes(SENTINEL)).toBe(false);
  });
});

// Persistent processes on a real tmux server: a private socket, never the user's server ($TMUX is removed from every
// child environment), killed at the end.
async function tmuxVersion(): Promise<string | null> {
  try { return (await exec("tmux", ["-V"])).stdout.trim(); } catch { return null; }
}

/** Every process's argv on this host, one per line: /proc on Linux, `ps -ww` elsewhere (macOS has no /proc). */
async function allArgv(): Promise<string[]> {
  if (process.platform === "linux") {
    return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).flatMap((pid) => {
      try { return [readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ")]; } catch { return []; }
    });
  }
  return (await exec("ps", ["-A", "-ww", "-o", "args="], { maxBuffer: 16 * 1024 * 1024 })).stdout.split("\n");
}

const sentinelHits = async (value: string) => (await allArgv()).filter((line) => line.includes(value)).length;

describe.skipIf(process.platform === "win32")("secret env channel on a real tmux server (spec 0017 Test)", () => {
  let home: string;
  let control: ChildProcess | undefined;
  const sockets: string[] = [];
  const childEnv = () => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, SHELL: "/bin/bash", TERM: "xterm-256color" };
    return env; // no TMUX, no TMUX_PANE: a bare tmux here can never reach the user's server
  };
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "openrig-sec183-tmux-")); });
  afterEach(async () => {
    control?.kill("SIGKILL"); control = undefined;
    for (const socket of sockets.splice(0)) await exec("tmux", ["-S", socket, "kill-server"], { env: childEnv() }).catch(() => {});
    rmSync(home, { recursive: true, force: true });
  });

  it("the argv scanner sees a long-lived sentinel argv (positive control) and a server started with -e (red)", async () => {
    const version = await tmuxVersion();
    if (!version) return;
    console.info(`[sec-183] ${version}, argv source: ${process.platform === "linux" ? "/proc/*/cmdline" : "ps -A -ww -o args"}`);
    const tag = `${SENTINEL}-control`;
    control = spawn("/bin/sh", ["-c", "sleep 30; :", "sh", tag], { stdio: "ignore", env: childEnv() });
    for (let i = 0; i < 40 && await sentinelHits(tag) === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await sentinelHits(tag)).toBeGreaterThanOrEqual(1);
    control.kill("SIGKILL"); control = undefined;
    // Red: today's -e on the command that starts the server stays on the server's argv for its life.
    const red = `${SENTINEL}-red`;
    const socket = path.join(home, "red.sock"); sockets.push(socket);
    await exec("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "red", "-e", `${NAME}=${red}`, "sleep 30"], { env: childEnv() });
    expect(await sentinelHits(red)).toBeGreaterThanOrEqual(1);
  });

  it("REQ-0017-01/03: a launch delivers the value to its runtime with no argv, session, global or new-pane copy", async () => {
    if (!await tmuxVersion()) return;
    const socket = path.join(home, "seat.sock"); sockets.push(socket);
    const tmux = async (args: string[]) => (await exec("tmux", ["-S", socket, ...args], { env: childEnv() })).stdout;
    const recorded: string[][] = [];
    const files = defaultTmuxFileOps();
    let n = 0;
    files.tmpName = () => path.join(home, `openrig-tmux-send-${process.pid}-00000000-0000-4000-8000-${String(++n).padStart(12, "0")}.txt`);
    const adapter = new TmuxAdapter(async () => { throw new Error("argv only"); }, files, async (args) => { recorded.push(args); return tmux(args.slice(1)); });
    const dir = secretLaunchDirPath(path.join(home, "openrig-home"));
    ensureSecretLaunchDir(dir);
    adapter.setSecretLaunchDir(dir);
    const out = path.join(home, "runtime-env");
    // The tmux server starts with this launch: it is the process that would keep a -e value on its argv.
    expect((await adapter.createSession("seat", home, { OPENRIG_NODE_ID: "node-1", [NAME]: SENTINEL }, { daemonOriginSecrets: [NAME] })).ok).toBe(true);
    for (let i = 0; i < 80 && !/sh$/.test((await tmux(["display-message", "-p", "-t", "=seat:", "#{pane_current_command}"])).trim()); i++) await new Promise((r) => setTimeout(r, 25));
    const runtime = `exec /bin/sh -c 'printf %s "$${NAME}" > "$0"; exec sleep 30' '${out}'`;
    expect((await adapter.sendShellCommand("seat", runtime)).ok).toBe(true);
    for (let i = 0; i < 200 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 25));
    // Delivery: the runtime has the value.
    expect(readFileSync(out, "utf8")).toBe(SENTINEL);
    // Persistent processes: the tmux server, the pane shell and the runtime hold no sentinel in their argv.
    expect(await sentinelHits(SENTINEL)).toBe(0);
    // Transient processes: no command the adapter ran held it.
    expect(recorded.some((args) => args.some((arg) => arg.includes(SENTINEL)))).toBe(false);
    // Residency: read only the named variable, in the session and the global environment.
    for (const scope of [["-t", "=seat"], ["-g"]]) {
      const shown = await tmux(["show-environment", ...scope, NAME]).catch((e: { stderr?: string }) => String(e.stderr ?? ""));
      expect(shown.includes(SENTINEL)).toBe(false);
    }
    // A new pane in the session doesn't inherit it.
    const split = path.join(home, "new-pane-env");
    await tmux(["new-window", "-d", "-t", "=seat:", `/bin/sh -c 'printf %s "\${${NAME}-unset}" > ${split}'`]);
    for (let i = 0; i < 200 && !existsSync(split); i++) await new Promise((r) => setTimeout(r, 25));
    expect(readFileSync(split, "utf8")).toBe("unset");
    // The script deleted itself before it exported anything, and nothing is left in the directory.
    expect(readdirSync(dir)).toEqual([]);
  }, 20_000);
});
