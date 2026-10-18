import { describe, it, expect } from "vitest";
import { resolveBindPlan } from "../src/domain/bind-plan.js";

// OPR.0.5.5.20 — bind intent has unambiguous provenance. The incident shape (operator
// baton qitem-20260827070400): a maintenance command in a managed environment carried
// OPENRIG_HOST=127.0.0.1; the daemon took single-bind and silently dropped Tailscale.

describe("S20 — resolveBindPlan: routing env is never bind intent", () => {
  it("INCIDENT SHAPE: injected routing env + no dedicated intent → DEFAULT bind, ignore is VISIBLE", () => {
    const plan = resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.60" });
    expect(plan.mode).toBe("default");
    // cerebral-work fork (CER-2924): the default is loopback only; tailnet exposure is opt-in.
    expect(plan.hosts).toEqual(["127.0.0.1"]);
    expect(plan.tailscaleDetected).toBe(true);
    expect(plan.ignoredRoutingHost).toBe("127.0.0.1"); // never silent — the provenance line's input
  });

  it("dedicated intent takes the explicit single-bind branch (the operator's channel, byte-uninjectable by managed env)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "100.95.124.51", routingHostEnv: "127.0.0.1", tailscaleIp: "100.95.124.51" });
    expect(plan.mode).toBe("explicit");
    expect(plan.hosts).toEqual(["100.95.124.51"]);
    expect(plan.ignoredRoutingHost).toBeUndefined(); // intent declared — nothing ignored
  });

  it("no env at all: default loopback-only, with or without tailscale (cerebral-work fork, CER-2924)", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: null }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"], tailscaleDetected: false });
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: "100.64.0.9" }).hosts)
      .toEqual(["127.0.0.1"]);
  });

  it("whitespace-only dedicated env is ABSENT (never an accidental single-bind on an empty string)", () => {
    const plan = resolveBindPlan({ bindHostEnv: "   ", routingHostEnv: undefined, tailscaleIp: "100.64.0.9" });
    expect(plan.mode).toBe("default");
    expect(plan.hosts).toEqual(["127.0.0.1"]);
  });
});

// cerebral-work fork (CER-2924): until the daemon authenticates its API, the default bind is
// loopback only. Binding the tailnet, or any other address, is an explicit OPENRIG_BIND_HOST opt-in.
describe("cerebral-work fork — default bind is loopback only; non-loopback is opt-in", () => {
  it("default: loopback only, no tailnet address in the plan, detection still reported", () => {
    expect(resolveBindPlan({ bindHostEnv: undefined, routingHostEnv: undefined, tailscaleIp: "100.86.3.65" }))
      .toEqual({ mode: "default", hosts: ["127.0.0.1"], tailscaleDetected: true });
  });

  it("explicit: OPENRIG_BIND_HOST set to a tailnet IP binds exactly that IP", () => {
    expect(resolveBindPlan({ bindHostEnv: "100.86.3.65", routingHostEnv: undefined, tailscaleIp: "100.86.3.65" }))
      .toEqual({ mode: "explicit", hosts: ["100.86.3.65"], tailscaleDetected: true });
  });

  it("explicit: OPENRIG_BIND_HOST=0.0.0.0 binds all interfaces (the bearer invariant still applies at startup)", () => {
    expect(resolveBindPlan({ bindHostEnv: "0.0.0.0", routingHostEnv: undefined, tailscaleIp: null }))
      .toEqual({ mode: "explicit", hosts: ["0.0.0.0"], tailscaleDetected: false });
  });
});
