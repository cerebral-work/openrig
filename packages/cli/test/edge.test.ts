// Spec 0008: `rig edge add <rig-id> <from> <to> --kind <kind>` posts to /api/rigs/:rigId/edges.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Command } from "commander";
import http from "node:http";
import { edgeCommand } from "../src/commands/edge.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

async function capture(fn: () => Promise<void>): Promise<{ out: string; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = origExit;
  return { out: logs.join("\n"), exitCode };
}

describe("rig edge add", () => {
  let server: http.Server;
  let port: number;
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as Record<string, unknown>;
        received.push({ url: req.url ?? "", body });
        const edge = { id: "e1", rigId: "rig-123", sourceId: "n-lead", targetId: "n-build", kind: body["kind"] };
        if (body["kind"] === "befriends") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, code: "invalid_kind", error: 'Unknown edge kind "befriends"' }));
        } else if (body["to"] === "dev.dup") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "exists", edge }));
        } else {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "created", edge }));
        }
      });
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function run(args: string[]) {
    const deps: StatusDeps = {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-10-18T00:00:00Z" } as DaemonState)
          : null),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(edgeCommand(deps));
    return capture(() => prog.parseAsync(["node", "rig", "edge", "add", ...args]).then(() => {}));
  }

  it("posts from, to and kind for the rig and reports the created edge", async () => {
    const { out, exitCode } = await run(["rig-123", "orch.lead", "dev.build", "--kind", "delegates_to"]);
    expect(received.at(-1)).toEqual({ url: "/api/rigs/rig-123/edges", body: { from: "orch.lead", to: "dev.build", kind: "delegates_to" } });
    expect(out).toContain("Added delegates_to edge orch.lead -> dev.build");
    expect(exitCode).toBeUndefined();
  });

  it("reports an existing edge as already present, exit 0", async () => {
    const { out, exitCode } = await run(["rig-123", "orch.lead", "dev.dup", "--kind", "delegates_to"]);
    expect(out).toContain("already exists");
    expect(exitCode).toBeUndefined();
  });

  it("prints the daemon's error and exits 1 on a rejected edge", async () => {
    const { out, exitCode } = await run(["rig-123", "orch.lead", "dev.build", "--kind", "befriends"]);
    expect(out).toContain('Unknown edge kind "befriends"');
    expect(exitCode).toBe(1);
  });

  it("--json prints the raw response", async () => {
    const { out } = await run(["rig-123", "orch.lead", "dev.build", "--kind", "can_observe", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: true, status: "created", edge: { kind: "can_observe" } });
  });
});
