// Spec 0017 item 4 (SEC-183): a secret-named value enters a seat only from the daemon's environment. Seat env (a rig
// spec's env:, rig up --env, a request's envOverride) refuses a secret-named name with seat_env_secret_name, and every
// check takes the name rule and its exact-name exemption list from one daemon export.
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isSecretSeatEnvName, SEAT_ENV_DEFAULT_BASE, SEAT_ENV_SECRET_NAME, SEAT_ENV_SECRET_NAME_EXEMPTIONS, seatEnvKeeps, seatEnvScrubScript, type SeatEnvPolicy } from "../src/domain/seat-launch-env-filter.js";
import { execFileSync } from "node:child_process";
import { secretSeatEnvOverrideNames, validateSeatEnv } from "../src/domain/seat-env.js";
import { secretNamedLaunchVars } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("the one rule and its exemption list (REQ-0017-14)", () => {
  it("is secret-named unless exempt by exact name", () => {
    expect(isSecretSeatEnvName("GITHUB_TOKEN")).toBe(true);
    expect(isSecretSeatEnvName("EXAMPLE_API_KEY")).toBe(true);
    expect(isSecretSeatEnvName("TOKENIZERS_PARALLELISM")).toBe(false);
    expect(isSecretSeatEnvName("TOKENIZERS_PARALLELISM_KEY")).toBe(true);
    expect(isSecretSeatEnvName("DEBUG")).toBe(false);
  });

  it("lists exact names the rule matches, each with a reason, starting with one", () => {
    expect(Object.keys(SEAT_ENV_SECRET_NAME_EXEMPTIONS)).toEqual(["TOKENIZERS_PARALLELISM"]);
    for (const [name, reason] of Object.entries(SEAT_ENV_SECRET_NAME_EXEMPTIONS)) {
      expect(name, name).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      expect(SEAT_ENV_SECRET_NAME.test(name), name).toBe(true);
      expect(reason.trim().length, name).toBeGreaterThan(0);
    }
  });

  it("has one definition in the source: every other check imports it", () => {
    const literal = "KEY|TOKEN|SECRET|PASSWORD|CRED|PASSPHRASE|PRIVATE";
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) {
          // The regex literal, or the words spelled as a quoted list (review r2 L1: the scrub had one).
          const text = fs.readFileSync(full, "utf-8");
          const copies = text.split(literal).length - 1 + (text.match(/["'`]KEY["'`]\s*,\s*["'`]TOKEN["'`]/g) ?? []).length;
          for (let i = 0; i < copies; i++) found.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    for (const pkg of fs.readdirSync(path.join(REPO_ROOT, "packages"))) {
      const src = path.join(REPO_ROOT, "packages", pkg, "src");
      if (fs.existsSync(src)) walk(src);
    }
    expect(found).toEqual(["packages/daemon/src/domain/seat-launch-env-filter.ts"]);
  });

  it("the launch guard exempts the same names", () => {
    expect(secretNamedLaunchVars({ TOKENIZERS_PARALLELISM: "false", GITHUB_TOKEN: "x", DEBUG: "1" })).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("the allow-list scrub uses the same rule and exemption list (review r2 L1 on #43)", () => {
  const policy = (base: readonly string[]): SeatEnvPolicy => ({ mode: "allowlist", base, exceptions: [], kubeconfig: "/scoped", rigs: [] });
  // Placeholder values only. The scrub runs in a real /bin/sh; the names left afterwards are what the command would get.
  const kept = (p: SeatEnvPolicy, explicit: string[]) => execFileSync("/bin/sh", ["-c",
    `${seatEnvScrubScript(p, explicit, "/deny/kubeconfig")}\nawk 'BEGIN { for (k in ENVIRON) print k }'`],
  { env: { HOME: "/h", PATH: process.env.PATH!, LANG: "C", TOKENIZERS_PARALLELISM: "false", EXAMPLE_API_KEY: "placeholder" }, encoding: "utf8" })
    .split("\n");
  it.each([
    ["base-listed", policy([...SEAT_ENV_DEFAULT_BASE, "TOKENIZERS_PARALLELISM"]), [], true],
    ["the launch's own name", policy(SEAT_ENV_DEFAULT_BASE), ["TOKENIZERS_PARALLELISM"], true],
    ["unlisted", policy(SEAT_ENV_DEFAULT_BASE), [], false],
  ] as const)("an exempt name %s: the scrub and seatEnvKeeps agree", (_label, p, explicit, expected) => {
    const names = kept(p, [...explicit]);
    expect(names.includes("TOKENIZERS_PARALLELISM")).toBe(expected);
    expect(seatEnvKeeps("TOKENIZERS_PARALLELISM", p, [...explicit])).toBe(expected);
    // Controls: a secret-named name the launch names is still dropped, and a base name survives.
    expect(kept(p, [...explicit, "EXAMPLE_API_KEY"]).includes("EXAMPLE_API_KEY")).toBe(false);
    expect(names.includes("LANG")).toBe(true);
  });
});

describe("seat env refuses a secret-named name (REQ-0017-13)", () => {
  it("a rig spec's env: refuses it with seat_env_secret_name, naming it and never its value", () => {
    const errors = validateSeatEnv({ GITHUB_TOKEN: "sentinel-spec-value", TOKENIZERS_PARALLELISM: "false", DEBUG: "1" }, "pods[0].members[0].env");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("pods[0].members[0].env.GITHUB_TOKEN");
    expect(errors[0]).toContain("seat_env_secret_name");
    expect(errors[0]).not.toContain("sentinel-spec-value");
  });

  it("names a request override's secret-named names, sorted, never values", () => {
    expect(secretSeatEnvOverrideNames({ GITHUB_TOKEN: "x", DEBUG: "1", AWS_SECRET: "y", TOKENIZERS_PARALLELISM: "false" })).toEqual(["AWS_SECRET", "GITHUB_TOKEN"]);
    expect(secretSeatEnvOverrideNames(null)).toEqual([]);
    expect(secretSeatEnvOverrideNames(["GITHUB_TOKEN=x"])).toEqual([]);
  });
});

describe("stored seat env with a secret-named name is refused at the next launch (REQ-0017-15)", () => {
  const dbs: Array<{ close(): void }> = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  function fixture() {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const createSession = vi.fn(async () => ({ ok: true as const }));
    const tmux = { createSession, listPanes: async () => [], listSessions: async () => [], hasSession: async () => false } as unknown as TmuxAdapter;
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv: { HOME: "/h" } });
    return { rigRepo, createSession, launcher };
  }

  it.each([
    ["member env", { member: { GITHUB_TOKEN: "sentinel-stored" } }, "env: of member dev1-impl"],
    ["rig env", { rig: { GITHUB_TOKEN: "sentinel-stored" } }, "rig-level env:"],
  ] as const)("%s: refused before any tmux command, naming the field and never the value", async (_label, where, field) => {
    const f = fixture();
    const rig = f.rigRepo.createRig("r01");
    f.rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "codex", env: "member" in where ? { ...where.member } : undefined });
    if ("rig" in where) f.rigRepo.setRigEnv(rig.id, { ...where.rig });
    const result = await f.launcher.launchNode(rig.id, "dev1-impl");
    expect(result).toMatchObject({ ok: false, code: "seat_env_secret_name" });
    const message = (result as { message: string }).message;
    expect(message).toContain("GITHUB_TOKEN");
    expect(message).toContain(field);
    expect(message).not.toContain("sentinel-stored");
    expect(f.createSession).not.toHaveBeenCalled();
  });

  it("an exempt name launches (control)", async () => {
    const f = fixture();
    const rig = f.rigRepo.createRig("r01");
    f.rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "codex", env: { TOKENIZERS_PARALLELISM: "false" } });
    await f.launcher.launchNode(rig.id, "dev1-impl");
    expect(f.createSession).toHaveBeenCalledTimes(1);
  });
});
