import { describe, it, expect } from "vitest";
import { seatLaunchExcludedEnvKeys } from "../src/domain/seat-launch-env-filter.js";
import { removeParentSessionEnv } from "../src/domain/parent-session-env.js";

// The seven names a tmux server recreated from a herdr pane carried into fresh seats
// (estate-onboarding/opus-swap-20261017/rina/herdr-env, names only).
const HERDR_PANE = {
  HERDR_BIN_PATH: "/opt/herdr",
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w4F:p1",
  HERDR_SESSION: "estate",
  HERDR_SOCKET_PATH: "/home/u/.config/herdr/sessions/estate/herdr.sock",
  HERDR_TAB_ID: "w4F:t1",
  HERDR_WORKSPACE_ID: "w4F",
};
const KEPT = {
  OPENRIG_HOME: "/r",
  OPENRIG_NODE_ID: "n1",
  OPENRIG_SESSION_NAME: "dev@rig",
  TMUX: "/tmp/tmux-1000/default,1,0",
  TMUX_PANE: "%1",
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "a",
  CLAUDE_CODE_OAUTH_TOKEN: "t",
  CLAUDE_CODE_USE_BEDROCK: "1",
};

describe("seatLaunchExcludedEnvKeys", () => {
  it("excludes every HERDR_* name from a seat launch, not only the named parent-session ones", () => {
    const keys = seatLaunchExcludedEnvKeys({ ...HERDR_PANE, ...KEPT });
    expect([...keys].sort()).toEqual(Object.keys(HERDR_PANE).sort());
  });

  it("keeps OpenRig metadata, tmux ancestry and credential channels", () => {
    expect(seatLaunchExcludedEnvKeys(KEPT)).toEqual([]);
  });

  it("still excludes the launching Claude Code session's identity", () => {
    expect(seatLaunchExcludedEnvKeys({ CLAUDECODE: "1", CLAUDE_EFFORT: "max", HERDR_SESSION: "estate" }))
      .toEqual(["CLAUDECODE", "CLAUDE_EFFORT", "HERDR_SESSION"]);
  });

  it("leaves the daemon's own environment rule alone: the daemon keeps HERDR_SOCKET_PATH for its herdr transport", () => {
    const env: Record<string, string | undefined> = { ...HERDR_PANE };
    removeParentSessionEnv(env);
    expect(env).toMatchObject({ HERDR_SOCKET_PATH: HERDR_PANE.HERDR_SOCKET_PATH, HERDR_SESSION: "estate" });
  });
});
