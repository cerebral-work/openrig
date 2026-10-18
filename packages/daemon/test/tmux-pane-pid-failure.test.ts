// Spec 0015: a failed tmux pane read is "unavailable", never "pane_missing". Only positive evidence of absence (tmux's own
// "can't find pane", or a session absent from a successful listing) may down-rank a running seat. Before this, a
// transient tmux failure under load turned every seat's pane read into null, so every running seat went pane_missing
// at once and `rig ps` showed them all attention_required (the cortex mesh flap, 2026-10-18).
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { identityVerdictDownranksRunning } from "../src/domain/types.js";

// How the production exec reports failures (tmux-exec.ts withExecOutput): tmux's own stderr is kept as execStderr.
const timeout = () => Object.assign(new Error("Command failed: tmux (timed out)"), { killed: true, signal: "SIGTERM", execStderr: "" });
const exitError = () => Object.assign(new Error("Command failed: tmux\nserver exited unexpectedly"), { code: 1, execStderr: "server exited unexpectedly\n" });
const paneGone = (pane: string) => Object.assign(new Error(`Command failed: tmux\ncan't find pane: ${pane}`), { code: 1, execStderr: `can't find pane: ${pane}\n` });

type PaneScript = { pid: number; command: string } | (() => Error);
function scriptedTmux(opts: { listing: Array<[string, number, string]> | (() => Error); panes: Record<string, PaneScript> }) {
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.startsWith("tmux list-panes -a")) {
      if (typeof opts.listing === "function") throw opts.listing();
      return opts.listing.map(([id, pid, command]) => `${id}|${pid}|${command}`).join("\n") + "\n";
    }
    const m = cmd.match(/^tmux display-message -p -t (\S+) ["']#\{(\w+)\}["']$/);
    if (!m) throw new Error(`unexpected: ${cmd}`);
    const pane = m[1]!.replace(/^'(.*)'$/, "$1"), script = opts.panes[pane];
    if (!script) throw paneGone(pane);
    if (typeof script === "function") throw script();
    return m[2] === "pane_pid" ? `${script.pid}\n` : `${script.command}\n`;
  });
  return new TmuxAdapter(exec as never);
}

describe("TmuxAdapter.observePanePid: absence only on tmux's own report", () => {
  const read = (script: PaneScript) => scriptedTmux({ listing: [], panes: { "%1": script } }).observePanePid("%1");
  it("a pid", async () => expect(await read({ pid: 4242, command: "node" })).toEqual({ kind: "pid", pid: 4242 }));
  it("tmux's \"can't find pane\" is absent", async () => {
    expect(await scriptedTmux({ listing: [], panes: {} }).observePanePid("%9")).toEqual({ kind: "absent" });
  });
  it("a timeout is unavailable", async () => expect(await read(timeout)).toEqual({ kind: "unavailable" }));
  it("another non-zero exit is unavailable", async () => expect(await read(exitError)).toEqual({ kind: "unavailable" }));
  it("\"can't find pane\" outside tmux's stderr is unavailable (pane output never classifies)", async () => {
    const spoof = () => Object.assign(new Error("Command failed: tmux\ncan't find pane: %1"), { code: 1, execStderr: "lost server\n" });
    expect(await read(spoof)).toEqual({ kind: "unavailable" });
  });
  it("getPanePid keeps its meaning for its other callers: null whenever there is no pid", async () => {
    expect(await scriptedTmux({ listing: [], panes: { "%1": exitError } }).getPanePid("%1")).toBeNull();
    expect(await scriptedTmux({ listing: [], panes: {} }).getPanePid("%1")).toBeNull();
  });
});

function seed(db: Database.Database, seats: Array<{ id: string; runtime: string; pane: string; token?: string }>) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  for (const seat of seats) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, ?, ?)").run(seat.id, "rig-1", `pod.${seat.id}`, seat.runtime, "/tmp");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, resume_token) VALUES (?, ?, ?, ?, ?, ?)")
      .run(`sess-${seat.id}`, seat.id, `${seat.id}@rig`, "running", "ready", seat.token ?? null);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, ?, ?, ?)")
      .run(`bind-${seat.id}`, seat.id, "tmux", `${seat.id}@rig`, seat.pane);
  }
}

// A terminal seat, a direct Claude seat, and a Claude seat with a resume token (read once in the selection pass).
const SEATS = [
  { id: "t1", runtime: "terminal", pane: "%1" },
  { id: "c1", runtime: "claude-code", pane: "%2" },
  { id: "c2", runtime: "claude-code", pane: "%3", token: "tok-c2" },
];

async function sweep(seats: typeof SEATS, real: TmuxAdapter) {
  const db = createFullTestDb();
  seed(db, seats);
  const tmux = {
    listSessions: vi.fn(async () => seats.map((seat) => ({ name: `${seat.id}@rig` })) as never),
    readAllPaneProcesses: () => real.readAllPaneProcesses(),
    getPanePid: (pane: string) => real.getPanePid(pane),
    getPaneCommand: (pane: string) => real.getPaneCommand(pane),
    observePanePid: (pane: string) => real.observePanePid(pane),
  };
  await new SeatIdentityReconciler({ db, tmux, now: () => new Date("2026-10-18T08:43:42.000Z") }).reconcileAll();
  const store = new SeatIdentityStore(db);
  const verdicts = Object.fromEntries(seats.map((seat) => [seat.id, store.getForNode(seat.id)]));
  db.close();
  return verdicts;
}

describe("the fleet identity sweep under tmux failures (spec 0015)", () => {
  it.each([["a timeout", timeout], ["a non-zero exit", exitError]])(
    "%s on the batch read and on every pane read leaves every running seat unavailable, none down-ranked", async (_label, failure) => {
      const verdicts = await sweep(SEATS, scriptedTmux({ listing: failure, panes: { "%1": failure, "%2": failure, "%3": failure } }));
      for (const seat of SEATS) {
        expect(verdicts[seat.id], seat.id).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
        expect(identityVerdictDownranksRunning(verdicts[seat.id]!.verdict), seat.id).toBe(false);
      }
    });

  it("a genuinely gone pane (a successful listing without it, and tmux's \"can't find pane\") is still pane_missing", async () => {
    const verdicts = await sweep(SEATS, scriptedTmux({
      listing: [["%1", 11, "zsh"], ["%3", 33, "claude"]],
      panes: { "%1": { pid: 11, command: "zsh" }, "%3": { pid: 33, command: "claude" } },
    }));
    expect(verdicts.c1).toMatchObject({ verdict: "pane_missing", reason: "pane_pid_gone" });
    expect(verdicts.t1).toMatchObject({ verdict: "verified" });
    expect(verdicts.c2).toMatchObject({ verdict: "verified" });
  });

  it("mixed: the batch fails, then one pane reads, one is gone and one fails", async () => {
    const verdicts = await sweep(SEATS, scriptedTmux({
      listing: timeout,
      panes: { "%1": { pid: 11, command: "zsh" }, "%3": exitError },
    }));
    expect(verdicts.t1).toMatchObject({ verdict: "verified" });
    expect(verdicts.c1).toMatchObject({ verdict: "pane_missing", reason: "pane_pid_gone" });
    expect(verdicts.c2).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
  });

  it("states upstream's Codex rule, kept: a failed read is mismatch for codex, named tmux_unavailable (a known gap)", async () => {
    const codex = [{ id: "x1", runtime: "codex", pane: "%4" }];
    const verdicts = await sweep(codex, scriptedTmux({ listing: timeout, panes: { "%4": exitError } }));
    expect(verdicts.x1).toMatchObject({ verdict: "mismatch", reason: "tmux_unavailable" });
  });
});

describe("the tokenless Claude sole-pane recheck under a tmux failure (spec 0015)", () => {
  function tokenless() {
    const db = createFullTestDb();
    seed(db, [{ id: "w1", runtime: "claude-code", pane: "%1" }]);
    // The recheck is the only read after listPanes in a sweep, so a pid failure armed for it hits only the recheck.
    const fail = { listPanes: false, pid: false };
    let recheck = false;
    const tmux = {
      listSessions: vi.fn(async () => { recheck = false; return [{ name: "w1@rig" }] as never; }),
      getPanePid: vi.fn(async () => (fail.pid && recheck ? null : 10)), // as the real adapter's, which delegates
      getPaneCommand: vi.fn(async () => "sh"),
      observePanePid: vi.fn(async () => (fail.pid && recheck ? { kind: "unavailable" as const } : { kind: "pid" as const, pid: 10 })),
      listPanes: vi.fn(async () => { recheck = true; if (fail.listPanes) throw exitError(); return [{ id: "%1" }] as never; }),
    };
    // A wrapper shell in the pane with Claude in its foreground: runtime-only proof, then the sole-pane recheck.
    const rows = [
      { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "sh", command: "sh", startedAt: "start" },
      { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command: "claude", startedAt: "start" },
    ];
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses: vi.fn(async () => rows), now: () => new Date("2026-10-18T08:43:42.000Z") });
    return { db, fail, rec, verdict: () => new SeatIdentityStore(db).getForNode("w1") };
  }

  it.each([["listPanes", "listPanes"], ["the pane pid", "pid"]] as const)(
    "a failed %s read in the recheck is unavailable, not process_identity_ambiguous", async (_label, which) => {
      const f = tokenless();
      await f.rec.reconcileAll();
      expect(f.verdict()).toMatchObject({ verdict: "verified" });
      f.fail[which] = true;
      await f.rec.reconcileAll();
      expect(f.verdict()).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
      f.db.close();
    });
});

describe("rebind proof under a failed pane pid read (spec 0015)", () => {
  function rebind(pid: { kind: "pid"; pid: number } | { kind: "absent" } | { kind: "unavailable" }) {
    const db = createFullTestDb();
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = repo.createRig("r"), node = repo.addNode(rig.id, "dev.qa", { runtime: "claude-code" });
    registry.registerSession(node.id, "dev-qa@r");
    const tmux = {
      listPanes: vi.fn(async () => [{ id: "%7" }] as never),
      getPanePid: vi.fn(async () => (pid.kind === "pid" ? pid.pid : null)),
      getPaneCommand: vi.fn(async () => "claude"),
      observePanePid: vi.fn(async () => pid),
    };
    return { db, nodeId: node.id, run: () => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id, sessionName: "dev-qa@r", runtime: "claude-code" }) };
  }

  it("a failed read of a pane the listing just showed writes no pane_missing; it reports the lookup failure", async () => {
    const f = rebind({ kind: "unavailable" });
    expect(await f.run()).toMatchObject({ ok: false, detail: expect.stringMatching(/lookup failed/) });
    expect(new SeatIdentityStore(f.db).getForNode(f.nodeId)?.verdict ?? null).not.toBe("pane_missing");
    f.db.close();
  });

  it("tmux's own \"can't find pane\" is still pane_missing", async () => {
    const f = rebind({ kind: "absent" });
    expect(await f.run()).toMatchObject({ ok: false });
    expect(new SeatIdentityStore(f.db).getForNode(f.nodeId)).toMatchObject({ verdict: "pane_missing", reason: "pane_pid_gone" });
    f.db.close();
  });
});
