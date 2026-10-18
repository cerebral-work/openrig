// Spec 0016: the sweep and the rebind read a native observation as proof, contrary or unavailable. A failed or partial
// read is not evidence that the seat's runtime is gone: the sweep records the runtime's unavailable verdict, and the
// rebind reports the lookup failed without moving the binding. Positive evidence of another process stays a mismatch.
// These go through the reconcilers' existing interfaces only, so they run unchanged against the base.
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { RigRepository } from "../src/domain/rig-repository.js";

// A pane whose root shell (pid 10) runs under a terminal session whose foreground group is `fg`.
const row = (pid: number, ppid: number, pgid: number, command: string, executableName: string, fg = 11, extra: Partial<NativeProcessRow> = {}): NativeProcessRow =>
  ({ pid, ppid, pgid, tpgid: fg, command, executableName, startedAt: `start-${pid}`, ...extra });
const shell = (fg = 11) => row(10, 1, 10, "sh", "sh", fg);
const claude = (pid = 11, token = "tok", extra: Partial<NativeProcessRow> & { ppid?: number; pgid?: number; fg?: number } = {}) =>
  row(pid, extra.ppid ?? 10, extra.pgid ?? pid, `claude --resume ${token}`, "claude", extra.fg ?? 11, extra);

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

// One seat in pane %1 (pid 10, a shell label), swept once with a scripted `ps`.
async function sweep(seat: { id: string; runtime: string; token?: string }, listProcesses: () => Promise<NativeProcessRow[]>) {
  const db = createFullTestDb();
  seed(db, [{ ...seat, pane: "%1" }]);
  const tmux = {
    listSessions: vi.fn(async () => [{ name: `${seat.id}@rig` }] as never),
    getPanePid: vi.fn(async () => 10),
    getPaneCommand: vi.fn(async () => "sh"),
    observePanePid: vi.fn(async () => ({ kind: "pid" as const, pid: 10 })),
    listPanes: vi.fn(async () => [{ id: "%1" }] as never),
  };
  await new SeatIdentityReconciler({ db, tmux, listProcesses: vi.fn(listProcesses), now: () => new Date("2026-10-18T17:00:00.000Z") }).reconcileAll();
  const verdict = new SeatIdentityStore(db).getForNode(seat.id);
  db.close();
  return verdict;
}
// The first `ps` fails; later ones return `rows`.
const failingOnce = (rows: NativeProcessRow[]) => { let calls = 0; return async () => { if (calls++ === 0) throw new Error("ps: timed out"); return rows; }; };

describe("the identity sweep (spec 0016 item 1)", () => {
  const managed = { id: "m1", runtime: "claude-code", token: "tok" };
  it("a verified managed Claude seat (control)", async () => {
    expect(await sweep(managed, async () => [shell(), claude()])).toMatchObject({ verdict: "verified" });
  });
  it("a managed Claude seat with one failed native sample is tmux_unavailable, not process_identity_ambiguous", async () => {
    expect(await sweep(managed, failingOnce([shell(), claude()]))).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
  });
  it("a contrary observation is mismatch / process_identity_mismatch", async () => {
    expect(await sweep(managed, async () => [shell(), claude(11, "other")])).toMatchObject({ verdict: "mismatch", reason: "process_identity_mismatch" });
  });
  it.each([
    ["the wrapper shape (the shell leads the foreground group)", [shell(10), claude(11, "tok", { pgid: 10, fg: 10 })], "verified", null],
    ["a terminal editor in Claude's group", [shell(), claude(), row(12, 11, 11, "vim", "vim")], "verified", null],
    ["Claude alive, the foreground held by its own shell escape", [shell(12), claude(11, "tok", { fg: 12 }), row(12, 11, 12, "sh", "sh", 12)], "mismatch", "process_identity_mismatch"],
    ["a second Claude in the foreground group", [shell(), claude(), row(12, 11, 11, "claude -p --resume tok", "claude")], "mismatch", "process_identity_mismatch"],
  ] as const)("the foreground rule: %s", async (_label, rows, verdict, reason) => {
    expect(await sweep(managed, async () => [...rows])).toMatchObject({ verdict, reason });
  });
  it("an unsampled seat is unavailable for one sweep only: the next sweep samples a bare shell as mismatch", async () => {
    const db = createFullTestDb();
    seed(db, [{ ...managed, pane: "%1" }]);
    const tmux = {
      listSessions: vi.fn(async () => [{ name: "m1@rig" }] as never),
      getPanePid: vi.fn(async () => 10),
      // The first selection read sees Claude; every later read sees the shell that took the pane.
      getPaneCommand: vi.fn(async () => "sh").mockResolvedValueOnce("claude"),
      observePanePid: vi.fn(async () => ({ kind: "pid" as const, pid: 10 })),
      listPanes: vi.fn(async () => [{ id: "%1" }] as never),
    };
    const rec = new SeatIdentityReconciler({ db, tmux, listProcesses: vi.fn(async () => [shell(10)]), now: () => new Date("2026-10-18T17:00:00.000Z") });
    const verdict = () => new SeatIdentityStore(db).getForNode("m1");
    await rec.reconcileAll();
    expect(verdict()).toMatchObject({ verdict: "tmux_unavailable", reason: "tmux_unavailable" });
    await rec.reconcileAll();
    expect(verdict()).toMatchObject({ verdict: "mismatch", reason: "process_identity_mismatch" });
    db.close();
  });
  it("Codex: unavailable is upstream's mismatch / tmux_unavailable; contrary is mismatch / process_identity_mismatch", async () => {
    const codex = { id: "x1", runtime: "codex", token: "tok" };
    const rows = [shell(), row(11, 10, 11, "codex resume tok", "codex")];
    expect(await sweep(codex, async () => rows)).toMatchObject({ verdict: "verified" });
    expect(await sweep(codex, failingOnce(rows))).toMatchObject({ verdict: "mismatch", reason: "tmux_unavailable" });
    expect(await sweep(codex, async () => [shell(10)])).toMatchObject({ verdict: "mismatch", reason: "process_identity_mismatch" });
  });
});

describe("the rebind (spec 0016 item 2)", () => {
  // A seat bound to %3 whose session now lists one pane, %7 (pid 10). `pidFailsFrom` fails the nth pane pid read on.
  function rebind(opts: { runtime: string; command: string; token?: string; strict?: boolean;
    listProcesses: () => Promise<NativeProcessRow[]>; listPanesFailsFrom?: number; pidFailsFrom?: number }) {
    const db = createFullTestDb();
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const rig = repo.createRig("r"), node = repo.addNode(rig.id, "pod.seat-a", { runtime: opts.runtime });
    registry.registerSession(node.id, "seat-a@r");
    registry.updateBinding(node.id, { tmuxSession: "seat-a@r", tmuxPane: "%3" });
    let listCalls = 0, pidReads = 0;
    const pidFails = () => ++pidReads >= (opts.pidFailsFrom ?? Infinity);
    const tmux = {
      listPanes: vi.fn(async () => { if (++listCalls >= (opts.listPanesFailsFrom ?? Infinity)) throw new Error("tmux: server exited unexpectedly"); return [{ id: "%7" }] as never; }),
      getPanePid: vi.fn(async () => (pidFails() ? null : 10)),
      getPaneCommand: vi.fn(async () => opts.command),
      observePanePid: vi.fn(async () => (pidFails() ? { kind: "unavailable" as const } : { kind: "pid" as const, pid: 10 })),
    };
    return {
      run: () => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id, sessionName: "seat-a@r",
        runtime: opts.runtime, expectedResumeToken: opts.token ?? null, requireExactResumeLineage: opts.strict, listProcesses: vi.fn(opts.listProcesses) }),
      verdict: () => new SeatIdentityStore(db).getForNode(node.id),
      pane: () => registry.getBindingForNode(node.id)?.tmuxPane ?? null,
      close: () => db.close(),
    };
  }
  const psFails = async (): Promise<NativeProcessRow[]> => { throw new Error("ps: timed out"); };
  const lookupFailed = { ok: false, detail: expect.stringMatching(/^tmux pane identity lookup failed/) };

  it.each([
    ["the Claude recheck: a failed ps", { runtime: "claude-code", command: "sh", token: "tok", listProcesses: psFails }],
    ["the Claude recheck: a failed listPanes", { runtime: "claude-code", command: "sh", token: "tok", listProcesses: async () => [shell(), claude()], listPanesFailsFrom: 2 }],
    ["the Claude recheck: a failed pid read", { runtime: "claude-code", command: "sh", token: "tok", listProcesses: async () => [shell(), claude()], pidFailsFrom: 4 }],
    ["the tokenless Claude wrapper: a failed ps", { runtime: "claude-code", command: "sh", listProcesses: psFails }],
    ["the Codex recheck: a failed ps", { runtime: "codex", command: "node", token: "tok", listProcesses: psFails }],
    ["the Codex recheck: a failed listPanes", { runtime: "codex", command: "node", token: "tok", listProcesses: async () => [shell(), row(11, 10, 11, "codex resume tok", "codex")], listPanesFailsFrom: 2 }],
    ["the strict branch: a failed ps", { runtime: "claude-code", command: "claude", token: "tok", strict: true, listProcesses: psFails }],
    ["the strict branch: an empty ps", { runtime: "claude-code", command: "claude", token: "tok", strict: true, listProcesses: async () => [] }],
  ])("%s reports the lookup failed, records no verdict and leaves the binding unchanged", async (_label, opts) => {
    const f = rebind(opts);
    expect(await f.run()).toMatchObject(lookupFailed);
    expect(f.verdict()).toBeNull();
    expect(f.pane()).toBe("%3");
    f.close();
  });

  it.each([
    ["the Claude recheck", { runtime: "claude-code", command: "sh", token: "tok", listProcesses: async () => [shell(), claude()] }],
    ["the Codex recheck", { runtime: "codex", command: "node", token: "tok", listProcesses: async () => [shell(), row(11, 10, 11, "codex resume tok", "codex")] }],
    ["the strict branch", { runtime: "claude-code", command: "claude", token: "tok", strict: true, listProcesses: async () => [row(10, 1, 10, "claude --resume tok", "claude", 10)] }],
  ])("control, %s: a proof verifies and rebinds", async (_label, opts) => {
    const f = rebind(opts);
    expect(await f.run()).toMatchObject({ ok: true, pane: "%7" });
    expect(f.verdict()).toMatchObject({ verdict: "verified" });
    expect(f.pane()).toBe("%7");
    f.close();
  });

  it("a contrary observation still records mismatch, binding first", async () => {
    const f = rebind({ runtime: "claude-code", command: "sh", token: "tok", listProcesses: async () => [shell(), claude(11, "other")] });
    expect(await f.run()).toMatchObject({ ok: false });
    expect(f.verdict()).toMatchObject({ verdict: "mismatch" });
    expect(f.pane()).toBe("%7");
    f.close();
  });
});
