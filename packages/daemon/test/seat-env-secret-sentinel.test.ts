// SEC-178 (review r2 on #15): a tmux failure carries the whole command line in its error, including every
// `-e NAME=VALUE` launch value. A failed launch must leave no value in its result, the database, events or
// logs: only a failure code and the failing step. Sentinels stand in for a secret and an allowed value.
import { describe, it, expect, vi, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SEAT_ENV_DEFAULT_BASE } from "../src/domain/seat-launch-env-filter.js";

const SECRET = "sentinel-secret-7f3a91";
const ALLOWED = "sentinel-allowed-c42e08";

/** An exec error as execFile and the control transport build it: the whole command line, then stderr. */
function execError(cmd: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { code: 1, stdout: "", stderr, execStderr: stderr });
}

function everyRow(db: Database.Database): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
}

function captureLogs(): string[] {
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
  return logs;
}

function adapter(failing: string, allowlist: boolean): TmuxAdapter {
  const tmux = new TmuxAdapter(async (cmd) => {
    const sub = cmd.split(" ")[1] ?? "";
    if (sub === failing) throw execError(cmd, sub === "new-session" ? "duplicate session: dev-build@r1" : "server exited unexpectedly");
    if (sub === "new-session") return "%1\n";
    // The server's global environment holds the operator's values; reading it must not leak them either.
    if (sub === "show-environment") return `HOME=/h\nOP_SERVICE_ACCOUNT_TOKEN=${SECRET}\nEDITOR=${ALLOWED}\n`;
    if (sub === "list-panes") return "%1|0|/w|80|24|1\n";
    return "";
  });
  if (allowlist) tmux.setSeatEnvPolicy(() => ({ mode: "allowlist", base: SEAT_ENV_DEFAULT_BASE, exceptions: [], kubeconfig: "/k", rigs: [] }), () => false);
  return tmux;
}

describe("a failed seat launch leaves no launch value behind (SEC-178)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["filter mode, new-session fails", "new-session", false],
    ["allow-list mode, removing names fails", "set-environment", true],
  ] as const)("%s", async (_label, failing, allowlist) => {
    const logs = captureLogs();
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const eventBus = new EventBus(db);
    const rig = rigRepo.createRig("r1");
    rigRepo.addNode(rig.id, "dev.build", { role: "worker", runtime: "claude-code" });
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus, tmuxAdapter: adapter(failing, allowlist) });
    const result = await launcher.launchNode(rig.id, "dev.build", { env: { EXAMPLE_PROVIDER_API_KEY: SECRET, CLAUDE_CONFIG_DIR: ALLOWED } });
    expect(result.ok).toBe(false);
    const everything = [JSON.stringify(result), everyRow(db), logs.join("\n")].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(ALLOWED);
    expect(JSON.stringify(result)).toMatch(allowlist ? /seat_env_refused.*step: remove disallowed names/ : /duplicate_session.*tmux new-session failed \(env names: [A-Z_, ]+\): duplicate session/);
    db.close();
  });

  it("a handover respawn whose -e values are on the command line fails without them", async () => {
    const logs = captureLogs();
    const result = await adapter("respawn-pane", false).respawnPane("%1", "claude --resume x", { env: { EXAMPLE_PROVIDER_API_KEY: SECRET, CLAUDE_CONFIG_DIR: ALLOWED } });
    expect(result).toEqual({ ok: false, code: "unknown", message: "tmux respawn-pane failed (env names: EXAMPLE_PROVIDER_API_KEY, CLAUDE_CONFIG_DIR)" });
    expect(logs.join("\n")).not.toContain(SECRET);
  });
});
