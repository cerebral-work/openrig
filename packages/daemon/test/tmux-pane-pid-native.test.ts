// Spec 0015 against a REAL tmux server (a private TMUX_TMPDIR, never the user's server), through both production
// transports. Review r1 on #18 (F1): tmux 3.4 answers `display-message -p -t <gone pane> '#{pane_pid}'` with exit 0 and an
// empty reply, so absence must be confirmed by a read that reports it (`list-panes -t <pane>`: "can't find pane"). Lifted
// from r1's probes (r1-pr18-real-tmux-probe, r1-pr18-sweep-probe).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import { supportsControlMode, tmuxControlExec } from "../src/adapters/tmux-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

const version = (() => {
  try { return execFileSync("tmux", ["-V"], { encoding: "utf8" }); } catch { return ""; }
})();

describe.skipIf(!supportsControlMode(version))("pane pid reads against a real tmux server (spec 0015)", () => {
  let dir: string;
  let control: ReturnType<typeof tmuxControlExec>;
  const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
  const transports = () => [
    ["argv", new TmuxAdapter(async () => "", undefined, execArgvCommand)],
    ["control", new TmuxAdapter(async () => "", undefined, control)],
  ] as const;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-panepid-"));
    vi.stubEnv("TMUX_TMPDIR", dir);
    vi.stubEnv("TMUX", "");
    control = tmuxControlExec(execArgvCommand);
  });

  afterEach(async () => {
    await control.close();
    try { tmux("kill-server"); } catch { /* already gone */ }
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  // Panes: a killed pane in a live session, a stale id from a session killed and recreated under the same name, and a
  // healthy control.
  function layout() {
    tmux("new-session", "-d", "-s", "killed@rig", "-x", "80", "-y", "24", "sleep 600");
    const killed = tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=killed@rig:", "sleep 600");
    tmux("kill-pane", "-t", killed);
    tmux("new-session", "-d", "-s", "stale@rig", "-x", "80", "-y", "24", "sleep 600");
    const stale = tmux("list-panes", "-t", "=stale@rig:", "-F", "#{pane_id}");
    tmux("kill-session", "-t", "=stale@rig");
    tmux("new-session", "-d", "-s", "stale@rig", "-x", "80", "-y", "24", "sleep 600");
    tmux("new-session", "-d", "-s", "healthy@rig", "-x", "80", "-y", "24", "sleep 600");
    const healthy = tmux("list-panes", "-t", "=healthy@rig:", "-F", "#{pane_id}");
    return { killed, stale, healthy };
  }

  it("observePanePid: a live pane has its pid; killed, stale and never-existing panes are absent, on both transports", async () => {
    const panes = layout();
    for (const [transport, adapter] of transports()) {
      expect(await adapter.observePanePid(panes.healthy), transport).toMatchObject({ kind: "pid" });
      for (const pane of [panes.killed, panes.stale, "%9999"]) {
        expect(await adapter.observePanePid(pane), `${transport} ${pane}`).toEqual({ kind: "absent" });
      }
    }
  });

  it("the fleet sweep: a killed pane and a stale pane id are pane_missing; a healthy seat is verified, on both transports", async () => {
    const panes = layout();
    const seats = [
      { id: "t1", runtime: "terminal", session: "killed@rig", pane: panes.killed },
      { id: "c1", runtime: "claude-code", session: "killed@rig", pane: panes.killed },
      { id: "t3", runtime: "terminal", session: "stale@rig", pane: panes.stale },
      { id: "t2", runtime: "terminal", session: "healthy@rig", pane: panes.healthy },
    ];
    for (const [transport, adapter] of transports()) {
      const db = createFullTestDb();
      db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
      for (const seat of seats) {
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, ?)").run(seat.id, "rig-1", `pod.${seat.id}`, seat.runtime, "/tmp");
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)")
          .run(`sess-${seat.id}`, seat.id, seat.session, "running", "ready");
        db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, ?, ?, ?)")
          .run(`bind-${seat.id}`, seat.id, "tmux", seat.session, seat.pane);
      }
      await new SeatIdentityReconciler({ db, tmux: adapter, now: () => new Date("2026-10-18T12:00:00.000Z") }).reconcileAll();
      const store = new SeatIdentityStore(db);
      for (const seat of ["t1", "c1", "t3"]) {
        expect(store.getForNode(seat), `${transport} ${seat}`).toMatchObject({ verdict: "pane_missing", reason: "pane_pid_gone" });
      }
      expect(store.getForNode("t2"), `${transport} t2`).toMatchObject({ verdict: "verified" });
      db.close();
    }
  });
});
