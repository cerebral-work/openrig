// Spec 0013 (SEC-178): the seat_env settings default to today's filter and refuse what the allow-list
// must never carry. Lockstep with the CLI store (cli/test/config-store-extended.test.ts lists the keys).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { ConfigStore } from "../../cli/src/config-store.js";
import { SEAT_ENV_DEFAULT_BASE } from "../src/domain/seat-launch-env-filter.js";

describe("seat_env settings (spec 0013)", () => {
  let dir: string;
  let store: SettingsStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seat-env-settings-"));
    store = new SettingsStore(join(dir, "config.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to filter mode, the shipped base list, no exceptions, every rig and the scoped kubeconfig", () => {
    expect(store.resolveOne("seat_env.mode").value).toBe("filter");
    expect(store.resolveOne("seat_env.base").value).toBe(SEAT_ENV_DEFAULT_BASE.join(","));
    expect(store.resolveOne("seat_env.exceptions").value).toBe("");
    expect(store.resolveOne("seat_env.rigs").value).toBe("");
    expect(String(store.resolveOne("seat_env.kubeconfig").value)).toMatch(/\/seat-env\/kubeconfig$/);
    expect(new ConfigStore(join(dir, "cli.json")).resolve().seatEnv.base).toBe(SEAT_ENV_DEFAULT_BASE.join(","));
  });

  it("refuses an unknown mode, a secret-named base name, a pattern or OP_SERVICE_ACCOUNT_TOKEN as an exception, and a relative kubeconfig", () => {
    expect(() => store.set("seat_env.mode", "strict")).toThrow(/filter.*allowlist/);
    expect(() => store.set("seat_env.base", "HOME,EXAMPLE_API_KEY")).toThrow(/secret-named/);
    expect(() => store.set("seat_env.exceptions", "EXAMPLE_*")).toThrow(/exact name/);
    expect(() => store.set("seat_env.exceptions", "OP_SERVICE_ACCOUNT_TOKEN")).toThrow(/never passed/);
    expect(() => store.set("seat_env.exceptions", "OP_SA_EXAMPLE_TOKEN")).toThrow(/never passed/);
    expect(() => store.set("seat_env.base", "HOME,OP_SA_EXAMPLE")).toThrow(/never passed/);
    expect(() => new ConfigStore(join(dir, "cli.json")).set("seat_env.exceptions", "OP_SA_EXAMPLE_TOKEN")).toThrow(/never passed/);
    expect(() => store.set("seat_env.kubeconfig", "kube/config")).toThrow(/absolute/);
    store.set("seat_env.mode", "allowlist");
    store.set("seat_env.exceptions", "EXAMPLE_API_KEY");
    store.set("seat_env.rigs", "cortex,dev-rig");
    expect(store.resolveOne("seat_env.mode").value).toBe("allowlist");
    expect(store.resolveOne("seat_env.exceptions").value).toBe("EXAMPLE_API_KEY");
  });
});
