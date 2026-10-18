import { describe, it, expect } from "vitest";
import { resolveBindPlan } from "../src/domain/bind-plan.js";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";

// cerebral-work fork (CER-2924): until the daemon authenticates its API, every daemon a test
// starts binds loopback only. The default plan adds the tailnet address when one is present.

describe("CER-2924 — test daemons bind loopback only", () => {
  it("the shared harness pins the bind env, so in-process and inheriting daemons plan loopback only", () => {
    expect(process.env.OPENRIG_BIND_HOST).toBe("127.0.0.1");
    const plan = resolveBindPlan({ bindHostEnv: process.env.OPENRIG_BIND_HOST, routingHostEnv: undefined, tailscaleIp: "100.86.3.65" });
    expect(plan.hosts).toEqual(["127.0.0.1"]);
  });

  it("the scenario scaffold pins loopback even when the caller's baseEnv asks for a public bind", () => {
    const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, OPENRIG_BIND_HOST: "0.0.0.0" } });
    try {
      expect(scaffold.env.OPENRIG_BIND_HOST).toBe("127.0.0.1");
    } finally {
      scaffold.cleanup();
    }
  });
});
