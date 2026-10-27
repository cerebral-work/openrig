import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  SEAT_ENV_ACTIVITY_TOKEN,
  SEAT_ENV_DEFAULT_BASE,
  SEAT_ENV_DENY_KUBECONFIG,
  SEAT_ENV_KEYS_INTERNAL,
  seatEnvAllowlistApplies,
  seatEnvKeeps,
  seatEnvPolicyFromSettings,
  seatEnvPolicyReader,
  seatEnvScrubScript,
  seatKubeconfig,
  seatLaunchExcludedEnvKeys,
  type SeatEnvPolicy,
} from "../src/domain/seat-launch-env-filter.js";

// Spec 0013 (SEC-178): names only; every value here is a placeholder.
const POLICY: SeatEnvPolicy = {
  mode: "allowlist",
  base: SEAT_ENV_DEFAULT_BASE,
  exceptions: [],
  kubeconfig: "/scoped/agent.kubeconfig",
  rigs: [],
};

const INHERITED = {
  HOME: "/h", PATH: "/usr/bin", LANG: "C.UTF-8", LC_ALL: "C", XDG_CONFIG_HOME: "/h/.config",
  TMUX: "/tmp/tmux-1000/default,1,0", SSH_AUTH_SOCK: "/run/agent", WSL_INTEROP: "/run/WSL/1_interop",
  OPENRIG_HOME: "/r", OPENRIG_NODE_ID: "n1",
  OP_SERVICE_ACCOUNT_TOKEN: "x", EXAMPLE_API_KEY: "x", EXAMPLE_ADMIN_PASSWORD: "x", KUBECONFIG: "/h/.kube/admin",
  EDITOR: "vi", HERDR_SOCKET_PATH: "/h/herdr.sock", CLAUDECODE: "1",
};

describe("seat env allow-list (spec 0013)", () => {
  it("filter mode, the default, is today's rule", () => {
    expect(seatLaunchExcludedEnvKeys(INHERITED, { ...POLICY, mode: "filter" }))
      .toEqual(seatLaunchExcludedEnvKeys(INHERITED));
  });

  it("allow-list mode drops every name that is not allowed, including KUBECONFIG and every secret name", () => {
    const dropped = seatLaunchExcludedEnvKeys(INHERITED, POLICY);
    expect([...dropped].sort()).toEqual([
      "CLAUDECODE", "EDITOR", "EXAMPLE_ADMIN_PASSWORD", "EXAMPLE_API_KEY", "HERDR_SOCKET_PATH", "KUBECONFIG",
      "OP_SERVICE_ACCOUNT_TOKEN",
    ]);
  });

  it("keeps base names, base patterns and the launch's explicit names", () => {
    for (const name of ["HOME", "PATH", "LC_ALL", "XDG_CONFIG_HOME", "TMUX", "SSH_AUTH_SOCK", "WSL_INTEROP", "OPENRIG_NODE_ID"]) {
      expect(seatEnvKeeps(name, POLICY), name).toBe(true);
    }
    expect(seatEnvKeeps("CLAUDE_CONFIG_DIR", POLICY, ["CLAUDE_CONFIG_DIR"])).toBe(true);
    expect(seatEnvKeeps("EDITOR", POLICY)).toBe(false);
  });

  it("refuses a secret-named name even when the base list or the launch names it", () => {
    const listed = { ...POLICY, base: [...POLICY.base, "EXAMPLE_API_KEY", "OPENRIG_*"] };
    expect(seatEnvKeeps("EXAMPLE_API_KEY", listed)).toBe(false);
    expect(seatEnvKeeps("OPENRIG_OTHER_TOKEN", listed)).toBe(false);
    expect(seatEnvKeeps("EXAMPLE_PROVIDER_API_KEY", POLICY, ["EXAMPLE_PROVIDER_API_KEY"])).toBe(false);
    expect(seatEnvKeeps("db_password", POLICY, ["db_password"])).toBe(false);
  });

  it("keeps the daemon-minted activity token, internal seat env keys, and named exceptions, never OP_SERVICE_ACCOUNT_TOKEN", () => {
    expect(SEAT_ENV_ACTIVITY_TOKEN).toBe("OPENRIG_ACTIVITY_HOOK_TOKEN");
    expect(SEAT_ENV_KEYS_INTERNAL).toBe("OPENRIG_SEAT_ENV_KEYS");
    expect(seatEnvKeeps(SEAT_ENV_ACTIVITY_TOKEN, POLICY)).toBe(true);
    // The key list is kept only when the launch itself set it (it is in `explicit`), never when merely inherited.
    expect(seatEnvKeeps(SEAT_ENV_KEYS_INTERNAL, POLICY, [SEAT_ENV_KEYS_INTERNAL])).toBe(true);
    expect(seatEnvKeeps(SEAT_ENV_KEYS_INTERNAL, POLICY)).toBe(false);
    expect(seatEnvKeeps(SEAT_ENV_KEYS_INTERNAL, POLICY, ["CLAUDE_CONFIG_DIR"])).toBe(false);
    const excepted = { ...POLICY, exceptions: ["EXAMPLE_API_KEY", "OP_SERVICE_ACCOUNT_TOKEN"] };
    expect(seatEnvKeeps("EXAMPLE_API_KEY", excepted)).toBe(true);
    expect(seatEnvKeeps("OP_SERVICE_ACCOUNT_TOKEN", excepted, ["OP_SERVICE_ACCOUNT_TOKEN"])).toBe(false);
  });

  // Review r2, R1: a name the shell cannot unset must stop the command, in every shell.
  const shells = ["bash", "zsh", "dash"].filter((sh) => spawnSync("sh", ["-c", `command -v ${sh}`]).status === 0);
  const runAfter = (sh: string, setup: string, extra: { env?: Record<string, string>; cwd?: string } = {}) => {
    const script = seatEnvScrubScript(POLICY, [], "/deny/kubeconfig");
    const count = `awk 'BEGIN { n = 0; for (k in ENVIRON) if (k ~ /^(EXAMPLE_TOKEN|BASH_FUNC_)/) n++; print n }'`;
    return spawnSync(sh, ["-c", `${setup}\n( ${script}\necho "opts=$-"; echo "survivors=$(${count})"; echo RAN )`],
      { env: { PATH: "/usr/bin:/bin", HOME: "/tmp", ...extra.env }, cwd: extra.cwd, encoding: "utf8" });
  };

  it.each(shells)("%s: a readonly secret export stops the command and reports seat_env_refused", (sh) => {
    const ran = runAfter(sh, "export EXAMPLE_TOKEN=placeholder; readonly EXAMPLE_TOKEN");
    expect(ran.stdout).not.toContain("RAN");
    expect(ran.stderr).toContain("seat_env_refused (step:");
    // The lead's ruling on round 2: the refusal names the step and the surviving names, never a value.
    expect(ran.stderr).toMatch(/seat_env_refused \(step: [a-z -]+; names: EXAMPLE_TOKEN\)/);
    expect(ran.stderr).not.toContain("placeholder");
  });

  // Review r2, R1b: without awk the listing is empty, so neither loop would run and the command would
  // run with every name. A listing that produced nothing refuses instead.
  it.each(shells)("%s: with no awk on the pane's PATH the command does not run", (sh) => {
    const ran = runAfter(sh, "export EXAMPLE_TOKEN=placeholder; PATH=/nonexistent/openrig-no-awk");
    expect(ran.stdout).not.toContain("RAN");
    expect(ran.stderr).toContain("seat_env_refused (step: list the environment");
    expect(ran.stderr).not.toContain("placeholder");
  });

  // Review r2, LOW: the listing is not pathname-expanded, so a name such as PAT* cannot match a file
  // named PATH in the working directory and pass as a kept name. Noglob is restored for the command.
  it.each(shells)("%s: names are not glob-expanded, and the command keeps the shell's glob setting", (sh) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-glob-"));
    try {
      fs.writeFileSync(path.join(dir, "PATH"), "");
      const ran = runAfter(sh, ":", { env: { "PAT*": "placeholder" }, cwd: dir });
      expect(ran.stderr).not.toContain("placeholder");
      if (ran.stdout.includes("RAN")) {
        // dash drops a non-identifier name itself; then nothing of it may survive.
        expect(spawnSync(sh, ["-c", "awk 'BEGIN { for (k in ENVIRON) if (k == \"PAT*\") print k }'"],
          { env: { PATH: "/usr/bin:/bin", "PAT*": "x" }, encoding: "utf8" }).stdout.trim()).toBe("");
      } else {
        expect(ran.stderr).toContain("seat_env_refused (step:");
      }
      const plain = runAfter(sh, ":");
      expect(plain.stdout).toContain("RAN");
      expect(plain.stdout).not.toMatch(/opts=[^\n]*f/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review r2, LOW: SHELLOPTS and BASHOPTS are readonly in bash; an rc that exports them must not make
  // every launch refuse. They are shell-option flags, not secrets.
  it.runIf(shells.includes("bash"))("bash: exported SHELLOPTS and BASHOPTS do not stop the command", () => {
    const ran = runAfter("bash", "export SHELLOPTS BASHOPTS");
    expect(ran.stderr).not.toContain("seat_env_refused");
    expect(ran.stdout).toContain("RAN");
  });

  it.each(shells)("%s: a removable secret export is removed and the command runs", (sh) => {
    const ran = runAfter(sh, "export EXAMPLE_TOKEN=placeholder");
    expect(ran.stdout).toContain("survivors=0");
    expect(ran.stdout).toContain("RAN");
  });

  it.runIf(shells.includes("bash"))("bash: an exported function is removed; one that cannot be unset stops the command", () => {
    const removed = runAfter("bash", "f() { :; }; export -f f");
    expect(removed.stdout).toContain("survivors=0");
    expect(removed.stdout).toContain("RAN");
    const stuck = runAfter("bash", "f() { :; }; export -f f; readonly -f f");
    expect(stuck.stdout).not.toContain("RAN");
    expect(stuck.stderr).toContain("seat_env_refused (step: re-list the environment; names: BASH_FUNC_f%%)");
  });

  it("names the locale and XDG directories exactly: no LC_* or XDG_* wildcard (review r2)", () => {
    for (const name of ["LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR"]) expect(seatEnvKeeps(name, POLICY), name).toBe(true);
    for (const name of ["LC_EVIL", "XDG_EVIL"]) expect(seatEnvKeeps(name, POLICY), name).toBe(false);
  });

  it("an unreadable policy refuses launches unless filter was the last policy read (review r2, R3)", () => {
    let raw: { mode: string; base: string; exceptions: string; kubeconfig: string; rigs: string } | null = null;
    const read = seatEnvPolicyReader(() => { if (!raw) throw new Error("malformed config"); return raw; }, () => {});
    expect(read()).toBe("unreadable");
    raw = { mode: "allowlist", base: "HOME", exceptions: "", kubeconfig: "/k", rigs: "" };
    expect(read()).toMatchObject({ mode: "allowlist" });
    raw = null;
    expect(read()).toBe("unreadable");
    raw = { mode: "filter", base: "HOME", exceptions: "", kubeconfig: "/k", rigs: "" };
    expect(read()).toMatchObject({ mode: "filter" });
    raw = null;
    expect(read()).toMatchObject({ mode: "filter" });
  });

  it("never passes a 1Password service-account name (OP_SA_*), by exception, base pattern or launch name", () => {
    const wide = { ...POLICY, base: [...POLICY.base, "OP_*"], exceptions: ["OP_SA_EXAMPLE_TOKEN"] };
    for (const name of ["OP_SA_EXAMPLE_TOKEN", "OP_SA_EXAMPLE"]) {
      expect(seatEnvKeeps(name, wide, [name]), name).toBe(false);
      expect(seatLaunchExcludedEnvKeys({ [name]: "x" }, wide, [name]), name).toEqual([name]);
    }
    const script = seatEnvScrubScript(wide, ["OP_SA_EXAMPLE"], "/deny");
    const out = execFileSync("/bin/sh", ["-c", `${script}\nenv | sed -n 's/^\\(OP_[A-Za-z0-9_]*\\)=.*/\\1/p'`],
      { env: { PATH: "/usr/bin:/bin", OP_SA_EXAMPLE_TOKEN: "x", OP_SA_EXAMPLE: "x", OP_OTHER: "kept by OP_*" }, encoding: "utf8" });
    expect(out.trim().split("\n")).toEqual(["OP_OTHER"]);
    const { policy, warnings } = seatEnvPolicyFromSettings({ mode: "allowlist", base: "HOME,OP_SA_EXAMPLE", exceptions: "OP_SA_EXAMPLE_TOKEN", kubeconfig: "/k", rigs: "" });
    expect(policy.base).toEqual(["HOME"]);
    expect(policy.exceptions).toEqual([]);
    expect(warnings.filter((w) => /never passed/.test(w))).toHaveLength(2);
  });

  it("reads settings: exact-name exceptions only, OP_SERVICE_ACCOUNT_TOKEN never, no secret names in the base", () => {
    const { policy, warnings } = seatEnvPolicyFromSettings({
      mode: "allowlist", base: "HOME, PATH, EXAMPLE_API_KEY, LC_*", exceptions: "EXAMPLE_API_KEY, EXAMPLE_*, OP_SERVICE_ACCOUNT_TOKEN",
      kubeconfig: "/k", rigs: "cortex, ",
    });
    expect(policy).toEqual({ mode: "allowlist", base: ["HOME", "PATH", "LC_*"], exceptions: ["EXAMPLE_API_KEY"], kubeconfig: "/k", rigs: ["cortex"] });
    expect(warnings.join("\n")).toMatch(/seat_env\.base names EXAMPLE_API_KEY/);
    expect(warnings.join("\n")).toMatch(/EXAMPLE_\*/);
    expect(warnings.join("\n")).toMatch(/OP_SERVICE_ACCOUNT_TOKEN/);
    expect(seatEnvPolicyFromSettings({ mode: "anything", base: "", exceptions: "", kubeconfig: "/k", rigs: "" }).policy.mode).toBe("filter");
  });

  it("sets KUBECONFIG to the configured file, or to a path that grants nothing while that file is absent", () => {
    expect(seatKubeconfig(POLICY, () => true)).toEqual({ path: "/scoped/agent.kubeconfig" });
    const absent = seatKubeconfig(POLICY, () => false);
    expect(absent.path).toBe(SEAT_ENV_DENY_KUBECONFIG);
    expect(absent.warning).toContain("/scoped/agent.kubeconfig");
  });

  it("pilots on named rigs; a session name with no rig follows the mode", () => {
    expect(seatEnvAllowlistApplies(POLICY, "dev@cortex")).toBe(true);
    const pilot = { ...POLICY, rigs: ["cortex"] };
    expect(seatEnvAllowlistApplies(pilot, "dev@cortex")).toBe(true);
    expect(seatEnvAllowlistApplies(pilot, "dev@vilicus")).toBe(false);
    expect(seatEnvAllowlistApplies(pilot, "openrig-probe-123")).toBe(true);
    expect(seatEnvAllowlistApplies({ ...POLICY, mode: "filter" }, "dev@cortex")).toBe(false);
    expect(seatEnvAllowlistApplies(undefined, "dev@cortex")).toBe(false);
  });

  it("the launch prologue keeps OPENRIG_SEAT_ENV_KEYS only when the launch set it, and drops an inherited one", () => {
    const env = { ...INHERITED, [SEAT_ENV_KEYS_INTERNAL]: "FOO,BAR" };
    const survivors = (explicit: string[]) => execFileSync("/bin/sh", ["-c",
      `${seatEnvScrubScript(POLICY, explicit, "/deny/kubeconfig")}\nenv | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'`], { env, encoding: "utf8" }).split("\n");
    expect(survivors([SEAT_ENV_KEYS_INTERNAL])).toContain(SEAT_ENV_KEYS_INTERNAL);
    expect(survivors([])).not.toContain(SEAT_ENV_KEYS_INTERNAL);
  });

  it("the launch prologue, run by a real sh, leaves only allowed names and the explicit KUBECONFIG", () => {
    const script = seatEnvScrubScript(POLICY, ["CLAUDE_CONFIG_DIR"], "/deny/kubeconfig");
    expect(script).not.toMatch(/\/h\/\.kube|x"/);
    const env = { ...INHERITED, CLAUDE_CONFIG_DIR: "/c", [SEAT_ENV_ACTIVITY_TOKEN]: "minted", Example_runner_Token: "x", FOO: "bar\nBAZ=1" };
    const out = execFileSync("/bin/sh", ["-c", `${script}\nenv | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p' | sort`], { env, encoding: "utf8" });
    const names = out.trim().split("\n").filter((name) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(name));
    expect(names).toEqual([
      "CLAUDE_CONFIG_DIR", "HOME", "KUBECONFIG", "LANG", "LC_ALL", SEAT_ENV_ACTIVITY_TOKEN, "OPENRIG_HOME", "OPENRIG_NODE_ID",
      "PATH", "SSH_AUTH_SOCK", "TMUX", "WSL_INTEROP", "XDG_CONFIG_HOME",
    ].sort());
    const kube = execFileSync("/bin/sh", ["-c", `${script}\nprintf %s "$KUBECONFIG"`], { env, encoding: "utf8" });
    expect(kube).toBe("/deny/kubeconfig");
  });
});
