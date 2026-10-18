// Spec 0013 (SEC-178): a private tmux server whose global environment carries an operator's credentials
// and whose pane shell's startup file exports more, as ~/.bashrc does on the estate. In allow-list mode
// the pane shell (layer 1) and every command the seat runs (layer 2) keep only allowed names, and
// KUBECONFIG is set explicitly. Filter mode, the control, still passes them through. Names only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SEAT_ENV_DEFAULT_BASE, SEAT_ENV_DENY_KUBECONFIG, type SeatEnvPolicy } from "../src/domain/seat-launch-env-filter.js";

const run = promisify(execFile);
const q = (v: string) => "'" + v.replaceAll("'", "'\"'\"'") + "'";

let hasTmux = false;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); hasTmux = true; } catch { /* optional dependency */ }

const OPERATOR = {
  OP_SERVICE_ACCOUNT_TOKEN: "placeholder", EXAMPLE_API_KEY: "placeholder", KUBECONFIG: "/admin/kubeconfig",
  EDITOR: "vi", HERDR_SOCKET_PATH: "/parent/herdr.sock",
};
// Names tmux's update-environment copies from the client that creates a session (review r2, INFO):
// the daemon has them, the server's global environment does not.
const CLIENT = { DISPLAY: ":9", KRB5CCNAME: "/tmp/krb5cc_placeholder", SSH_CONNECTION: "placeholder", SSH_AUTH_SOCK: "/tmp/agent.sock" };
const POLICY: SeatEnvPolicy = { mode: "allowlist", base: SEAT_ENV_DEFAULT_BASE, exceptions: [], kubeconfig: "/scoped/absent", rigs: [] };

async function paneEnvironNames(tm: (args: string[]) => Promise<string>, target: string): Promise<Record<string, string>> {
  for (let i = 0; i < 200; i++) {
    const pid = (await tm(["display-message", "-p", "-t", target, "#{pane_pid}"])).trim();
    const file = `/proc/${pid}/environ`;
    if (/^\d+$/.test(pid) && fs.existsSync(file)) {
      const env: Record<string, string> = {};
      for (const entry of fs.readFileSync(file, "utf8").split("\0")) {
        const eq = entry.indexOf("=");
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      if (env.TMUX) return env;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no readable pane environment for ${target}`);
}

async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the launched command never wrote ${file}`);
}

describe.skipIf(!hasTmux || process.platform !== "linux")("seat env allow-list on a real tmux server (spec 0013)", () => {
  it.each(["allowlist", "filter"] as const)("%s mode: what the pane shell and a launched command keep", async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-allow-"));
    const socket = path.join(root, "tmux");
    const rc = path.join(root, "rc");
    // Like a startup file exporting credential references: names the tmux environment never had.
    fs.writeFileSync(rc, "export REFS_API_TOKEN=placeholder\nexport REFS_PLAIN=1\nPS1='$ '\n");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/bash", ...OPERATOR };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
    const adapter = new TmuxAdapter(async (cmd) => {
      if (!cmd.startsWith("tmux ")) throw new Error("unexpected fixture command");
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env: { ...env, ...CLIENT }, timeout: 8000 })).stdout;
    });
    if (mode === "allowlist") adapter.setSeatEnvPolicy(() => POLICY, () => false);
    try {
      await tm(["new-session", "-d", "-s", "anchor"]);
      await tm(["set-option", "-g", "default-command", `bash --rcfile ${q(rc)} -i`]);

      const created = await adapter.createSession("dev@rig", root, { OPENRIG_NODE_ID: "n1", CLAUDE_CONFIG_DIR: "/c", EXAMPLE_PROVIDER_API_KEY: "placeholder" });
      expect(created.ok).toBe(true);
      const shell = await paneEnvironNames(tm, "=dev@rig:");

      const names = path.join(root, "names"), kube = path.join(root, "kube");
      const sent = await adapter.sendShellCommand("dev@rig",
        `env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | sort > ${q(names)}.tmp; printf '%s' "\${KUBECONFIG-unset}" > ${q(kube)}; mv ${q(names)}.tmp ${q(names)}`,
        undefined, { sourceInPane: true });
      expect(sent).toEqual({ ok: true });
      const launched = (await waitForFile(names)).trim().split("\n");
      const kubeconfig = fs.readFileSync(kube, "utf8");

      if (mode === "allowlist") {
        expect(created).toEqual({ ok: true, warnings: [expect.stringContaining(SEAT_ENV_DENY_KUBECONFIG)] });
        for (const gone of ["OP_SERVICE_ACCOUNT_TOKEN", "EXAMPLE_API_KEY", "EDITOR", "HERDR_SOCKET_PATH", "EXAMPLE_PROVIDER_API_KEY"]) {
          expect(shell[gone], `pane shell: ${gone}`).toBeUndefined();
        }
        expect(shell.KUBECONFIG).toBe(SEAT_ENV_DENY_KUBECONFIG);
        for (const gone of ["OP_SERVICE_ACCOUNT_TOKEN", "EXAMPLE_API_KEY", "EDITOR", "HERDR_SOCKET_PATH", "EXAMPLE_PROVIDER_API_KEY", "REFS_API_TOKEN", "REFS_PLAIN"]) {
          expect(launched, `launched command: ${gone}`).not.toContain(gone);
        }
        expect(launched).toEqual(expect.arrayContaining(["HOME", "PATH", "TMUX", "OPENRIG_NODE_ID", "CLAUDE_CONFIG_DIR", "KUBECONFIG"]));
        expect(kubeconfig).toBe(SEAT_ENV_DENY_KUBECONFIG);
        // update-environment names follow the allow-list: SSH_AUTH_SOCK is a base name, the rest are not.
        for (const gone of ["DISPLAY", "KRB5CCNAME", "SSH_CONNECTION"]) {
          expect(shell[gone], `pane shell: ${gone}`).toBeUndefined();
          expect(launched, `launched command: ${gone}`).not.toContain(gone);
        }
        expect(launched).toContain("SSH_AUTH_SOCK");
      } else {
        // The control: without the allow-list the same seat sees the operator's names.
        expect(launched).toEqual(expect.arrayContaining(["OP_SERVICE_ACCOUNT_TOKEN", "EXAMPLE_API_KEY", "REFS_API_TOKEN", "KUBECONFIG", "DISPLAY", "KRB5CCNAME"]));
        expect(kubeconfig).toBe("/admin/kubeconfig");
      }
    } finally {
      await tm(["kill-server"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // Review r2, R2: the resume-metadata probe starts a real Claude with sendLaunchCommand; R1: a readonly
  // export the rc makes cannot be removed, so the command must not run.
  it.each(["probe path", "readonly export"] as const)("allow-list mode, %s", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-allow-"));
    const socket = path.join(root, "tmux");
    const rc = path.join(root, "rc");
    fs.writeFileSync(rc, kind === "readonly export"
      ? "export REFS_API_TOKEN=placeholder\nreadonly REFS_API_TOKEN\nPS1='$ '\n"
      : "export REFS_API_TOKEN=placeholder\nexport REFS_PLAIN=1\nPS1='$ '\n");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/bash", ...OPERATOR };
    const tm = async (args: string[]) => (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 8000 })).stdout;
    const adapter = new TmuxAdapter(async (cmd) => {
      if (!cmd.startsWith("tmux ")) throw new Error("unexpected fixture command");
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout;
    });
    adapter.setSeatEnvPolicy(() => POLICY, () => false);
    try {
      await tm(["new-session", "-d", "-s", "anchor"]);
      await tm(["set-option", "-g", "default-command", `bash --rcfile ${q(rc)} -i`]);
      const probe = "rigged-refresh-dev-rig-test";
      expect((await adapter.createProbeSession(probe, root)).ok).toBe(true);
      const names = path.join(root, "names");
      const sent = await adapter.sendLaunchCommand(probe,
        `env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | sort > ${q(names)}.tmp; mv ${q(names)}.tmp ${q(names)}`);
      expect(sent).toEqual({ ok: true });
      if (kind === "probe path") {
        const launched = (await waitForFile(names)).trim().split("\n");
        for (const gone of ["OP_SERVICE_ACCOUNT_TOKEN", "EXAMPLE_API_KEY", "REFS_API_TOKEN", "REFS_PLAIN", "KUBECONFIG_ADMIN"]) {
          expect(launched, gone).not.toContain(gone);
        }
        expect(launched).toEqual(expect.arrayContaining(["HOME", "PATH", "KUBECONFIG"]));
      } else {
        let screen = "";
        for (let i = 0; i < 200 && !screen.includes("seat_env_refused"); i++) {
          await new Promise((r) => setTimeout(r, 25));
          screen = await tm(["capture-pane", "-p", "-t", `=${probe}:`]);
        }
        expect(screen).toContain("seat_env_refused (step:");
        expect(screen).not.toContain("placeholder");
        expect(fs.existsSync(names)).toBe(false);
      }
    } finally {
      await tm(["kill-server"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  // Review r2, INFO: in a session layer 1 never touched, the names update-environment copied are still in
  // the session's own environment. The prologue must not count them as the launch's own.
  it("allow-list mode, a session the adapter did not create: update-environment names follow the allow-list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-allow-"));
    const socket = path.join(root, "tmux");
    const env = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", SHELL: "/bin/bash" };
    const tm = async (args: string[], extra: Record<string, string> = {}) =>
      (await run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env: { ...env, ...extra }, timeout: 8000 })).stdout;
    const adapter = new TmuxAdapter(async (cmd) => {
      if (!cmd.startsWith("tmux ")) throw new Error("unexpected fixture command");
      return (await run("/bin/sh", ["-c", cmd.replace(/^tmux /, `tmux -S ${q(socket)} -f /dev/null `)], { env, timeout: 8000 })).stdout;
    });
    adapter.setSeatEnvPolicy(() => POLICY, () => false);
    try {
      await tm(["new-session", "-d", "-s", "anchor"]);
      await tm(["new-session", "-d", "-s", "dev2@rig", "bash --norc -i"], CLIENT);
      expect(await tm(["show-environment", "-t", "=dev2@rig"])).toContain("KRB5CCNAME=");
      const names = path.join(root, "names");
      const sent = await adapter.sendShellCommand("dev2@rig",
        `env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | sort > ${q(names)}.tmp; mv ${q(names)}.tmp ${q(names)}`,
        undefined, { sourceInPane: true });
      expect(sent).toEqual({ ok: true });
      const launched = (await waitForFile(names)).trim().split("\n");
      for (const gone of ["DISPLAY", "KRB5CCNAME", "SSH_CONNECTION"]) expect(launched, gone).not.toContain(gone);
      expect(launched).toContain("SSH_AUTH_SOCK");
    } finally {
      await tm(["kill-server"]).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
