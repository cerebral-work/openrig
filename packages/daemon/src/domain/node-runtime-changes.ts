import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { SeatEnv } from "./seat-env.js";

/** Spec 0005 (cerebral-work fork): the runtime-change ledger and the per-node revert slot (migration 115). */

/** One side of a change. `permission` is a mode, or null for inherit. */
export interface RuntimeSide {
  runtime: string | null;
  model: string | null;
  cwd: string | null;
  effort: string | null;
  permission: string | null;
  env: SeatEnv | null;
}

export interface RuntimeChangeRecord {
  nodeId: string;
  kind: "change" | "revert";
  revertsChangeId?: string | null;
  outcome: "committed" | "failed";
  failure?: string | null;
  generationUuid?: string | null;
  from: RuntimeSide;
  to: RuntimeSide;
  specPath?: string | null;
  /** The sha256 of the spec text the daemon parsed and validated (the CLI sends the file at specPath). */
  specSha256?: string | null;
  approval: string;
  reason: string;
  operator: string;
}

/** What a revert of a node's last committed change restores. Holds member env values, like nodes.env_json. */
export interface RevertBefore {
  runtime: string | null;
  model: string | null;
  cwd: string | null;
  effort: string | null;
  effortChoice: string | null;
  codexConfigProfile: string | null;
  envJson: string | null;
  permission: { runtime: string; mode: string; actor: string; reason: string } | null;
  startupContext: { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string; runtime: string } | null;
  /** The occupant session that ran before the change, whose recorded resume token a revert may resume. */
  predecessorSessionId: string | null;
}

/** Env names with a sha256 of each value: what the ledger and the event may hold. */
export function envFingerprint(env: SeatEnv | null): Array<{ name: string; sha256: string }> | null {
  if (!env) return null;
  return Object.keys(env).sort().map((name) => ({ name, sha256: createHash("sha256").update(env[name]!).digest("hex") }));
}

export class NodeRuntimeChangeLedger {
  constructor(private readonly db: Database.Database) {}

  record(entry: RuntimeChangeRecord): string {
    const id = ulid();
    const fingerprint = (env: SeatEnv | null) => {
      const names = envFingerprint(env);
      return names ? JSON.stringify(names) : null;
    };
    this.db.prepare(`INSERT INTO node_runtime_changes (id, node_id, kind, reverts_change_id, outcome, failure, generation_uuid,
        from_runtime, to_runtime, from_model, to_model, from_cwd, to_cwd, from_effort, to_effort, from_permission, to_permission,
        from_env, to_env, spec_path, spec_sha256, approval, reason, operator, acceptance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, entry.nodeId, entry.kind, entry.revertsChangeId ?? null, entry.outcome, entry.failure ?? null, entry.generationUuid ?? null,
      entry.from.runtime, entry.to.runtime, entry.from.model, entry.to.model, entry.from.cwd, entry.to.cwd,
      entry.from.effort, entry.to.effort, entry.from.permission, entry.to.permission,
      fingerprint(entry.from.env), fingerprint(entry.to.env), entry.specPath ?? null, entry.specSha256 ?? null,
      entry.approval, entry.reason, entry.operator, entry.outcome === "committed" ? "pending" : null,
    );
    return id;
  }

  /** The node's latest committed change and its declaration marker (migration 116), or null. */
  latestCommitted(nodeId: string): { id: string; generationUuid: string | null; declaredAt: string | null; declaredBy: string | null } | null {
    const row = this.db.prepare(`SELECT id, generation_uuid, declared_at, declared_by FROM node_runtime_changes
      WHERE node_id = ? AND outcome = 'committed' ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(nodeId) as
      { id: string; generation_uuid: string | null; declared_at: string | null; declared_by: string | null } | undefined;
    return row ? { id: row.id, generationUuid: row.generation_uuid, declaredAt: row.declared_at, declaredBy: row.declared_by } : null;
  }

  /** The committed change's occupant swap was declared to the activity oracle. Set once; a declared row is untouched. */
  markDeclared(changeId: string, declaredBy: string): void {
    this.db.prepare(`UPDATE node_runtime_changes SET declared_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), declared_by = ?
      WHERE id = ? AND outcome = 'committed' AND declared_at IS NULL`).run(declaredBy, changeId);
  }

  revertSlot(nodeId: string): { changeId: string; before: RevertBefore } | null {
    const row = this.db.prepare("SELECT change_id, before_json FROM node_runtime_revert_slots WHERE node_id = ?").get(nodeId) as
      { change_id: string; before_json: string } | undefined;
    return row ? { changeId: row.change_id, before: JSON.parse(row.before_json) as RevertBefore } : null;
  }

  setRevertSlot(nodeId: string, changeId: string, before: RevertBefore): void {
    this.db.prepare("INSERT OR REPLACE INTO node_runtime_revert_slots (node_id, change_id, before_json) VALUES (?, ?, ?)")
      .run(nodeId, changeId, JSON.stringify(before));
  }

  clearRevertSlot(nodeId: string): void {
    this.db.prepare("DELETE FROM node_runtime_revert_slots WHERE node_id = ?").run(nodeId);
  }
}
