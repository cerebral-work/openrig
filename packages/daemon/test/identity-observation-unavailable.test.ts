// Spec 0016: the sweep reads a native observation as proof, contrary or unavailable. A failed or partial read is not
// evidence that the seat's runtime is gone: the sweep records the runtime's unavailable verdict. Positive evidence of
// another process stays a mismatch. These go through the reconciler's existing interface only, so they run unchanged
// against the base. (The rebind is unchanged: spec 0016 item 2 is a follow-up.)
import { describe, it, expect, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";

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
