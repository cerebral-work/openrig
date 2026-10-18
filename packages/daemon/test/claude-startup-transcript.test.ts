import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter, encodeClaudeProjectDir, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { inspectStartupTranscript } from "../src/domain/startup-transcript-evidence.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Spec 0012: delivery of a startup send is confirmed only from the seat's own transcript, after the send.
const SENT = "# revenant startup context\n\nRead TOPOLOGY.md first.\nThen inspect your owned queue.";
const T0 = Date.parse("2026-10-17T23:45:11.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const jsonl = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const pasted = (text: string) => `\n\n<pasted_content id="990a">\n${text}\n</pasted_content id="990a">`;

describe("inspectStartupTranscript", () => {
  it("verifies a user turn after the send whose pasted block matches by sha", () => {
    const result = inspectStartupTranscript(jsonl({ type: "user", timestamp: at(300_000), message: { role: "user", content: pasted(SENT) } }), SENT, T0);
    expect(result).toMatchObject({ outcome: "verified", recordType: "user", at: at(300_000) });
  });

  it("verifies a queued_command attachment whose prompt matches by sha", () => {
    const record = { type: "attachment", timestamp: at(2_000), attachment: { type: "queued_command", prompt: pasted(SENT) } };
    expect(inspectStartupTranscript(jsonl(record), SENT, T0)).toMatchObject({ outcome: "verified", recordType: "attachment" });
  });

  it("verifies a user turn whose text array part is exactly the sent text, whitespace aside", () => {
    const record = { type: "user", timestamp: at(500), message: { content: [{ type: "text", text: SENT.replace(/\n/g, "  \n") }] } };
    expect(inspectStartupTranscript(jsonl(record), SENT, T0)).toMatchObject({ outcome: "verified" });
  });

  it("ignores a matching record from before the send", () => {
    const record = { type: "user", timestamp: at(-1), message: { content: pasted(SENT) } };
    expect(inspectStartupTranscript(jsonl(record), SENT, T0).outcome).toBe("not_found");
  });

  it("reports a single text-free enqueue after the send as enqueued_unconfirmed, never verified", () => {
    const result = inspectStartupTranscript(jsonl(
      { type: "queue-operation", operation: "enqueue", timestamp: at(80) },
      { type: "user", timestamp: at(500), message: { content: pasted("the identity prompt, a different text") } },
    ), SENT, T0);
    expect(result).toMatchObject({ outcome: "enqueued_unconfirmed", at: at(80) });
  });

  it("reports an enqueue whose text matches as enqueued_unconfirmed: queued is not consumed", () => {
    const result = inspectStartupTranscript(jsonl({ type: "queue-operation", operation: "enqueue", timestamp: at(80), content: pasted(SENT) }), SENT, T0);
    expect(result).toMatchObject({ outcome: "enqueued_unconfirmed", at: at(80) });
  });

  it("does not attribute a text-free enqueue when two enqueues followed the send", () => {
    const result = inspectStartupTranscript(jsonl(
      { type: "queue-operation", operation: "enqueue", timestamp: at(80) },
      { type: "queue-operation", operation: "enqueue", timestamp: at(90) },
    ), SENT, T0);
    expect(result.outcome).toBe("not_found");
  });

  it("does not attribute another sender's enqueue that carries different text", () => {
    const result = inspectStartupTranscript(jsonl({ type: "queue-operation", operation: "enqueue", timestamp: at(80), content: "From: operator\nQueue handoff" }), SENT, T0);
    expect(result.outcome).toBe("not_found");
  });

  it("never carries transcript or sent text, only types, counts, times and the hash", () => {
    const result = inspectStartupTranscript(jsonl(
      { type: "user", timestamp: at(10), message: { content: "SECRET-LOOKING other text" } },
      { type: "queue-operation", operation: "enqueue", timestamp: at(20) },
    ), SENT, T0);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-LOOKING");
    expect(serialized).not.toContain("TOPOLOGY");
    expect(result.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.postSendRecords).toEqual({ user: 1, "queue-operation": 1 });
  });

  it("skips unparseable lines and records without a timestamp", () => {
    const text = "not json\n" + jsonl({ type: "user", message: { content: pasted(SENT) } });
    expect(inspectStartupTranscript(text, SENT, T0).outcome).toBe("not_found");
  });
});

describe("encodeClaudeProjectDir", () => {
  it.each([
    ["/home/ctodie/.openrig/workspaces/estate/revenant", "-home-ctodie--openrig-workspaces-estate-revenant"],
    ["/home/ctodie/.openrig/workspaces/estate/vilicus/dev-qa", "-home-ctodie--openrig-workspaces-estate-vilicus-dev-qa"],
  ])("encodes %s as Claude names its project directory", (cwd, encoded) => {
    expect(encodeClaudeProjectDir(cwd)).toBe(encoded);
  });
});

describe("ClaudeCodeAdapter.confirmStartupText reads only this launch's own transcript", () => {
  const binding: NodeBinding = { id: "b1", nodeId: "n1", tmuxSession: "seat@rig", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/work/seat" };
  const tmux = { sendText: vi.fn(async () => ({ ok: true as const })), sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true), getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => "") } as unknown as TmuxAdapter;
  const fsWith = (files: Record<string, string>) => {
    const fsOps = { readFile: vi.fn((p: string) => { if (p in files) return files[p]!; throw new Error(`ENOENT ${p}`); }),
      exists: vi.fn((p: string) => p in files), writeFile: vi.fn(), mkdirp: vi.fn(), copyFile: vi.fn(), homedir: "/home/u" };
    return fsOps as unknown as ClaudeAdapterFsOps & { readFile: ReturnType<typeof vi.fn>; exists: ReturnType<typeof vi.fn> };
  };
  const ownPath = "/cfg/projects/-work-seat/fixed-session-id.jsonl";

  it("reads exactly <config>/projects/<encoded cwd>/<launch session id>.jsonl after a fresh launch", async () => {
    const fsOps = fsWith({ [ownPath]: jsonl({ type: "user", timestamp: at(100), message: { content: pasted(SENT) } }) });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "fixed-session-id", claudeConfigDir: "/cfg" });
    await adapter.launchHarness(binding, { name: "seat" });
    expect(await adapter.confirmStartupText(binding, SENT, T0)).toMatchObject({ outcome: "verified" });
    expect(fsOps.readFile.mock.calls.filter(([p]) => String(p).endsWith(".jsonl"))).toEqual([[ownPath]]);
  });

  it("is unavailable, reading nothing, when this adapter has no launch for the node", async () => {
    const fsOps = fsWith({ [ownPath]: jsonl({ type: "user", timestamp: at(100), message: { content: pasted(SENT) } }) });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, claudeConfigDir: "/cfg" });
    expect(await adapter.confirmStartupText(binding, SENT, T0)).toMatchObject({ outcome: "unavailable" });
    expect(fsOps.readFile).not.toHaveBeenCalled();
  });

  it("is unavailable when the launch's own transcript file does not exist", async () => {
    const fsOps = fsWith({ "/cfg/projects/-work-seat/someone-else.jsonl": jsonl({ type: "user", timestamp: at(100), message: { content: pasted(SENT) } }) });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, sessionIdFactory: () => "fixed-session-id", claudeConfigDir: "/cfg" });
    await adapter.launchHarness(binding, { name: "seat" });
    expect(await adapter.confirmStartupText(binding, SENT, T0)).toMatchObject({ outcome: "unavailable" });
    expect(fsOps.readFile.mock.calls.filter(([p]) => String(p).endsWith(".jsonl"))).toEqual([]);
  });
});
