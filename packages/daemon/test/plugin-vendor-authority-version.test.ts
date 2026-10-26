// A fork build's version carries a pre-release part (0.7.2-cw.1-rc.1). The vendor service compares plain x.y.z
// versions only, so the daemon hands it the numeric core. Before this, `rigs` was never installed on a fork daemon
// and startup logged "invalid version ... expected numeric x.y.z authority" on every boot.

import { describe, it, expect } from "vitest";
import { vendorAuthorityVersion } from "../src/domain/plugin-vendor-service.js";

describe("vendorAuthorityVersion", () => {
  it.each([
    ["0.7.2", "0.7.2"],
    ["0.7.2-cw.1-rc.1", "0.7.2"],
    ["0.6.10-cw.4.5", "0.6.10"],
    ["1.12.30-rc.2", "1.12.30"],
    [" 0.7.2-cw.1 ", "0.7.2"],
  ])("takes the numeric core of %s", (input, expected) => {
    expect(vendorAuthorityVersion(input)).toBe(expected);
  });

  it.each(["unknown", "", "0.7", "v0.7.2", "0.7.2.1", "x.y.z"])(
    "leaves %j unchanged, so the service still refuses it",
    (input) => {
      expect(vendorAuthorityVersion(input)).toBe(input);
    },
  );
});
