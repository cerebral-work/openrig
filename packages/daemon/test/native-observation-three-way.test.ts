// Spec 0016: a native process observation is proof, contrary or unavailable. A failed or partial read is never evidence
// that the seat's runtime is gone: the sweep records the runtime's unavailable verdict, and the rebind reports the lookup
// failed without moving the binding. Positive evidence of another process stays a mismatch.
import { describe, it, expect, vi } from "vitest";
import {
  classifyNativePane, combineNativeSamples, observeNativePaneTyped,
  type NativeObservationResult, type NativeProcessRow,
} from "../src/domain/native-process-lineage.js";
import { readNativeExecutableErrors } from "../src/domain/native-process-executable.js";

// A pane whose root shell (pid 10) runs under a terminal session whose foreground group is `fg`.
const row = (pid: number, ppid: number, pgid: number, command: string, executableName: string, fg = 11, extra: Partial<NativeProcessRow> = {}): NativeProcessRow =>
  ({ pid, ppid, pgid, tpgid: fg, command, executableName, startedAt: `start-${pid}`, ...extra });
const shell = (fg = 11) => row(10, 1, 10, "sh", "sh", fg);
const claude = (pid = 11, token = "tok", extra: Partial<NativeProcessRow> & { ppid?: number; pgid?: number; fg?: number } = {}) =>
  row(pid, extra.ppid ?? 10, extra.pgid ?? pid, `claude --resume ${token}`, "claude", extra.fg ?? 11, extra);
const identity = { identity: true, expectedToken: "tok" };
const kind = (result: NativeObservationResult) => result.kind;

describe("the three-way observer (spec 0016 item 1)", () => {
  it("Claude in its own foreground group under the pane shell is proof", () => {
    expect(kind(classifyNativePane([shell(), claude()], 10, "claude-code", identity))).toBe("proof");
  });
  it("the wrapper shape (the shell leads the foreground group, Claude inside it) is proof", () => {
    expect(kind(classifyNativePane([shell(10), claude(11, "tok", { pgid: 10, fg: 10 })], 10, "claude-code", identity))).toBe("proof");
  });
  it("a terminal editor in Claude's group is proof", () => {
    const vim = row(12, 11, 11, "vim notes.md", "vim");
    expect(kind(classifyNativePane([shell(), claude(), vim], 10, "claude-code", identity))).toBe("proof");
  });
  it("Claude alive with the foreground held by a shell descending from it (an editor shell escape) is contrary", () => {
    const escape = row(12, 11, 12, "sh", "sh", 12);
    expect(classifyNativePane([shell(12), claude(11, "tok", { fg: 12 }), escape], 10, "claude-code", identity))
      .toMatchObject({ kind: "contrary", reason: expect.stringMatching(/not in its foreground/) });
  });
  it("Claude alive with the foreground held by a non-descendant is contrary", () => {
    const other = row(13, 10, 13, "vim", "vim", 13);
    expect(kind(classifyNativePane([shell(13), claude(11, "tok", { fg: 13 }), other], 10, "claude-code", identity))).toBe("contrary");
  });
  it.each([
    ["a second Claude with -p, descendant", row(12, 11, 11, "claude -p --resume tok", "claude")],
    ["a second Claude without -p, descendant", row(12, 11, 11, "claude --resume tok", "claude")],
    ["a second Claude, not a descendant", row(12, 10, 11, "claude", "claude")],
  ])("%s in the foreground group is contrary", (_label, second) => {
    expect(kind(classifyNativePane([shell(), claude(), second], 10, "claude-code", identity))).toBe("contrary");
    expect(kind(classifyNativePane([shell(), claude(), second], 10, "claude-code", { identity: false }))).toBe("contrary");
  });
  it("a Claude naming another conversation is contrary; the recorded rotation is proof", () => {
    expect(classifyNativePane([shell(), claude(11, "other")], 10, "claude-code", identity))
      .toMatchObject({ kind: "contrary", reason: expect.stringMatching(/different conversation/) });
    const rotation = { token: "old", process: { pid: 11, startedAt: "start-11" } };
    expect(kind(classifyNativePane([shell(), claude(11, "old")], 10, "claude-code", { ...identity, rotation }))).toBe("proof");
  });
  it("a Codex process in a Claude seat's foreground group is contrary", () => {
    const codex = row(12, 11, 11, "codex", "codex");
    expect(classifyNativePane([shell(), claude(), codex], 10, "claude-code", identity))
      .toMatchObject({ kind: "contrary", reason: expect.stringMatching(/different agent runtime/) });
  });
  it("no runtime under the pane, with every process read, is contrary", () => {
    expect(classifyNativePane([shell(10)], 10, "claude-code", identity))
      .toMatchObject({ kind: "contrary", reason: expect.stringMatching(/no runtime/) });
  });
  it("no candidate while a process under the pane was not fully read is unavailable", () => {
    expect(kind(classifyNativePane([shell(), claude(11, "tok", { startedAt: undefined })], 10, "claude-code", identity))).toBe("unavailable");
  });
  it.each([
    ["zero rows", [] as NativeProcessRow[]],
    ["the pane pid missing from the rows", [claude()]],
    ["a repeated pid", [shell(), claude(), claude()]],
    ["a pane root without a foreground group", [{ ...shell(), tpgid: undefined }, claude()]],
  ])("%s is unavailable", (_label, rows) => {
    expect(kind(classifyNativePane(rows, 10, "claude-code", identity))).toBe("unavailable");
  });
  it("a native Claude with no executable path and no recorded read error is not a candidate (#273's unknown path)", () => {
    const unknown = claude(11, "tok", { executableName: "2.1.302" });
    expect(classifyNativePane([shell(), unknown], 10, "claude-code", identity))
      .toMatchObject({ kind: "contrary", reason: expect.stringMatching(/no runtime/) });
  });
  it("a native Claude whose executable read hit ENOENT/ESRCH is unavailable; EACCES is contrary", () => {
    const native = (executablePathError?: "exited" | "refused") =>
      claude(11, "tok", { executableName: "2.1.302", executablePathError });
    expect(kind(classifyNativePane([shell(), native("exited")], 10, "claude-code", identity))).toBe("unavailable");
    expect(kind(classifyNativePane([shell(), native("refused")], 10, "claude-code", identity))).toBe("contrary");
    // Control: the same process with its witness read is proof.
    const witnessed = claude(11, "tok", { executableName: "2.1.302", executablePath: "/opt/u/.local/share/claude/versions/2.1.302" });
    expect(kind(classifyNativePane([shell(), witnessed], 10, "claude-code", identity))).toBe("proof");
  });
  it("a refused executable read beside a proven Claude is contrary, not ignored", () => {
    const refused = row(12, 11, 11, "claude --resume tok", "2.1.302", 11, { executablePathError: "refused" });
    expect(kind(classifyNativePane([shell(), claude(), refused], 10, "claude-code", identity))).toBe("contrary");
    expect(kind(classifyNativePane([shell(), claude()], 10, "claude-code", identity))).toBe("proof");
  });
  it("precedence: a candidate naming another conversation beside a failed read is contrary", () => {
    const exited = row(12, 11, 11, "claude --resume tok", "2.1.302", 11, { executablePathError: "exited" });
    expect(kind(classifyNativePane([shell(), claude(11, "other"), exited], 10, "claude-code", identity))).toBe("contrary");
  });
  it("Codex: a sole Codex candidate naming the token is proof; a Claude in its foreground is contrary", () => {
    const codex = row(11, 10, 11, "codex resume tok", "codex");
    expect(kind(classifyNativePane([shell(), codex], 10, "codex", { identity: true, expectedToken: "tok" }))).toBe("proof");
    expect(kind(classifyNativePane([shell(), codex, row(12, 11, 11, "claude", "claude")], 10, "codex", { identity: true, expectedToken: "tok" }))).toBe("contrary");
  });
  it("a Claude seat proved for identity without a token is unavailable", () => {
    expect(kind(classifyNativePane([shell(), claude()], 10, "claude-code", { identity: true, expectedToken: null }))).toBe("unavailable");
  });
});

describe("observeNativePaneTyped: failed reads are unavailable", () => {
  const tmux = (pid: () => Promise<number | null>) => ({ getPanePid: vi.fn(pid) });
  it("a ps that throws", async () => {
    expect(kind(await observeNativePaneTyped({ target: "%1", tmux: tmux(async () => 10), listProcesses: async () => { throw new Error("ps"); }, expectedToken: "tok" }, "claude-code", true))).toBe("unavailable");
  });
  it("a pane pid read that throws or reads nothing", async () => {
    const rows = async () => [shell(), claude()];
    expect(kind(await observeNativePaneTyped({ target: "%1", tmux: tmux(async () => { throw new Error("tmux"); }), listProcesses: rows, expectedToken: "tok" }, "claude-code", true))).toBe("unavailable");
    expect(kind(await observeNativePaneTyped({ target: "%1", tmux: tmux(async () => null), listProcesses: rows, expectedToken: "tok" }, "claude-code", true))).toBe("unavailable");
    expect(kind(await observeNativePaneTyped({ target: "%1", tmux: tmux(async () => 10), listProcesses: rows, expectedToken: "tok" }, "claude-code", true))).toBe("proof");
  });
});

describe("combining the sweep's two samples (spec 0016 item 1 table)", () => {
  const proof = (fingerprint: string): NativeObservationResult =>
    ({ kind: "proof", observation: { panePid: 10, process: claude(), fingerprint } });
  const contrary: NativeObservationResult = { kind: "contrary", reason: "c" };
  const unavailable: NativeObservationResult = { kind: "unavailable", reason: "u" };
  const columns = [["proof (same)", proof("a")], ["proof (other)", proof("b")], ["contrary", contrary], ["unavailable", unavailable]] as const;
  const table: Record<string, [NativeObservationResult, string[]]> = {
    proof: [proof("a"), ["proof", "contrary", "unavailable", "unavailable"]],
    contrary: [contrary, ["unavailable", "unavailable", "contrary", "contrary"]],
    unavailable: [unavailable, ["unavailable", "unavailable", "contrary", "unavailable"]],
  };
  for (const [first, [sample, expected]] of Object.entries(table)) {
    columns.forEach(([label, second], index) => {
      it(`${first} then ${label} is ${expected[index]}`, () => expect(kind(combineNativeSamples(sample, second))).toBe(expected[index]));
    });
  }
});

describe.runIf(process.platform === "linux")("readNativeExecutableErrors (Linux)", () => {
  it("an exited pid is exited; the caller's own pid reads (control)", async () => {
    const errors = await readNativeExecutableErrors([2147483646, process.pid]);
    expect(errors.get(2147483646)).toBe("exited");
    expect(errors.has(process.pid)).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)("another user's process is refused", async () => {
    expect((await readNativeExecutableErrors([1])).get(1)).toBe("refused");
  });
});
