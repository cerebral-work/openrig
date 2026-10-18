// Spec 0017 items 1-3 (SEC-183): the channel's building blocks, on real shells. The trace and wrapper cases each run the
// red form beside the fix, so a test that can't see a leak can't pass for clean. Children get an explicit minimal env.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDaemonSecretResolver, ensureSecretLaunchDir, MANAGED_SECRET_WRAPPER, SECRET_SCRIPT_TRACE_GUARD,
  secretExportLines, secretLaunchDir, sweepSecretLaunchDir, withoutDaemonSecrets,
} from "../src/domain/seat-secret-launch.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const scratch = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "s17-")); roots.push(root); return root; };
const run = (argv: string[], home: string) => spawnSync(argv[0]!, argv.slice(1), { env: { PATH: process.env.PATH!, HOME: home }, encoding: "utf8" });
const available = (shell: string) => spawnSync("/bin/sh", ["-c", `command -v ${shell}`]).status === 0;
const shIsDash = (() => { try { return path.basename(fs.realpathSync("/bin/sh")) === "dash"; } catch { return false; } })();

// A plain token to count in traces, and a value with every character single quotes must survive.
const TOKEN = "SENTINELVALUE0017";
const AWKWARD = `${TOKEN} it's $HOME \`x\` \\n "q"`;

describe("the resolver (REQ-0017-16)", () => {
  const resolve = buildDaemonSecretResolver(
    { ANTHROPIC_API_KEY: "a", OPENAI_BASE_URL: "http://x", EMPTY_TOKEN: "" },
    { omp: { OMP_EXTRA_API_KEY: "o", TOKENIZERS_PARALLELISM: "false" }, codex: { CODEX_TOKEN: "c" } },
  );
  it("gives the secret-named values of the provider-auth env and the runtime's own env, nothing else", () => {
    expect(resolve("omp")).toEqual({ ANTHROPIC_API_KEY: "a", OMP_EXTRA_API_KEY: "o" });
    expect(resolve("claude-code")).toEqual({ ANTHROPIC_API_KEY: "a" });
    expect(resolve(null)).toEqual({ ANTHROPIC_API_KEY: "a" });
  });
  it("strips exactly the resolver's names: a secret-named seat-env name stays for 0013 item 9's guard to refuse", () => {
    const env = { ANTHROPIC_API_KEY: "a", GITHUB_TOKEN: "from-seat-env", DEBUG: "1" };
    expect(withoutDaemonSecrets(env, resolve("claude-code"))).toEqual({ GITHUB_TOKEN: "from-seat-env", DEBUG: "1" });
  });
});

describe("the directory (REQ-0017-11)", () => {
  it("is absolute under a relative OPENRIG_HOME", () => {
    expect(path.isAbsolute(secretLaunchDir("relative-home"))).toBe(true);
    expect(secretLaunchDir("/h")).toBe("/h/seat-env/launch");
  });
  it("is created 0700, and refused as a symlink, another mode, a file or another uid's", async () => {
    const root = scratch();
    const dir = path.join(root, "seat-env", "launch");
    expect(await ensureSecretLaunchDir(dir)).toEqual({ ok: true });
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o755);
    expect(await ensureSecretLaunchDir(dir)).toMatchObject({ ok: false, code: "secret_launch_dir_refused", message: expect.stringContaining("mode 755") });
    fs.chmodSync(dir, 0o700);
    expect(await ensureSecretLaunchDir(dir, fs.lstatSync(dir).uid + 1)).toMatchObject({ ok: false, message: expect.stringContaining("owned by uid") });
    const link = path.join(root, "link");
    fs.symlinkSync(dir, link);
    expect(await ensureSecretLaunchDir(link)).toMatchObject({ ok: false, message: expect.stringContaining("symbolic link") });
    const file = path.join(root, "file");
    fs.writeFileSync(file, "", { mode: 0o700 });
    expect(await ensureSecretLaunchDir(file)).toMatchObject({ ok: false, message: expect.stringContaining("not a directory") });
  });
});

describe("export lines (REQ-0017-10)", () => {
  it("round-trip any value through /bin/sh, each value alone on its export line", () => {
    const root = scratch();
    const text = secretExportLines({ S: AWKWARD, T: "two" });
    for (const line of text.split("\n").filter((l) => l.includes(TOKEN))) expect(line).toMatch(/^export S='.*'$/);
    const file = path.join(root, "exports");
    fs.writeFileSync(file, text, { mode: 0o600 });
    expect(run(["/bin/sh", "-c", `. "$1" && printf %s "$S"`, "_", file], root).stdout).toBe(AWKWARD);
  });
  it("refuses an invalid name or a NUL byte, naming no value", () => {
    expect(() => secretExportLines({ "bad name": "v" })).toThrow(/invalid name/);
    expect(() => secretExportLines({ S: "a\0b" })).toThrow(/^secret launch value: S contains a NUL byte$/);
  });
});

describe("the tracing guard (R1, REQ-0017-09)", () => {
  const traced: Array<[string, string, string[]]> = [
    ["bash -x", "bash", ["-c", 'set -x; ( . "$1" )']],
    ["bash -v", "bash", ["-c", 'set -v; ( . "$1" )']],
    ["zsh xtrace", "zsh", ["-f", "-c", 'setopt xtrace; ( . "$1" )']],
  ];
  it.each(traced)("%s prints no value with the guard, and the value without it", (_label, shell, args) => {
    if (!available(shell)) return;
    const root = scratch();
    const script = (guard: boolean) => {
      const file = path.join(root, `staged-${guard}`);
      fs.writeFileSync(file, `${guard ? `${SECRET_SCRIPT_TRACE_GUARD}\n` : ""}${secretExportLines({ S: TOKEN })}true\n`, { mode: 0o600 });
      return file;
    };
    const count = (file: string) => (run([shell, ...args, "_", file], root).stderr.match(new RegExp(TOKEN, "g")) ?? []).length;
    expect(count(script(true))).toBe(0);
    expect(count(script(false))).toBeGreaterThan(0);
  });
});

describe.runIf(shIsDash)("the managed wrapper under dash (REQ-0017-06)", () => {
  const OLD_WRAPPER = `. "$0"; s=$?; rm -f -- "$0"; [ "$s" -eq 0 ] && exec "$@"`;
  function launch(wrapper: string, content: string | null) {
    const root = scratch();
    const file = path.join(root, "secret-file");
    if (content !== null) fs.writeFileSync(file, content, { mode: 0o600 });
    const out = path.join(root, "runtime-saw");
    const result = run(["/bin/sh", "-c", wrapper, file, "/bin/sh", "-c", `printf %s "$S" > "${out}"`], root);
    return { status: result.status, fileLeft: fs.existsSync(file), runtimeSaw: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null };
  }
  it("delivers the value to the exec'd runtime, and the file is gone", () => {
    expect(launch(MANAGED_SECRET_WRAPPER, secretExportLines({ S: AWKWARD }))).toEqual({ status: 0, fileLeft: false, runtimeSaw: AWKWARD });
  });
  it("an aborting '.' (a syntax error) leaves no file and starts nothing; the earlier wrapper leaves the file", () => {
    const broken = `${secretExportLines({ S: TOKEN })}if then\n`;
    const fixed = launch(MANAGED_SECRET_WRAPPER, broken);
    expect(fixed.status).not.toBe(0);
    expect(fixed.fileLeft).toBe(false);
    expect(fixed.runtimeSaw).toBeNull();
    expect(launch(OLD_WRAPPER, broken).fileLeft).toBe(true);
  });
  it("a missing file exits non-zero and starts nothing", () => {
    const missing = launch(MANAGED_SECRET_WRAPPER, null);
    expect(missing.status).not.toBe(0);
    expect(missing.runtimeSaw).toBeNull();
  });
});

describe("the startup sweep (REQ-0017-12)", () => {
  it("deletes every file, a fresh one included", async () => {
    const dir = path.join(scratch(), "launch");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "old"), "x");
    fs.writeFileSync(path.join(dir, "fresh"), "x");
    fs.utimesSync(path.join(dir, "old"), new Date(0), new Date(0));
    expect(await sweepSecretLaunchDir(dir)).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(await sweepSecretLaunchDir(path.join(dir, "absent"))).toBe(0);
  });
});
