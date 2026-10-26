// OPR.0.4.6.FAC1 — the role-resolution CONTEXT builder: the impure
// half that materializes the pure policy's fact array from the shipped
// rig-scoped inventory projection + the SYNCHRONOUS work-enrichment.
//
// SYNC-ONLY BY CONSTRUCTION (arch Q1 = guard B4): this composes
// `getNodeInventory` (synchronous SQL projection — lifecycle already
// folds session status, restore outcome, and the identity-verdict
// down-rank) with `attachTerminalActivityAndWork` WITHOUT a
// SeatActivityService (so `terminalActive` stays undefined and only the
// sync pending-work map is computed). The ASYNC `attachAgentActivity`
// tmux-probe path is STRUCTURALLY absent — it cannot enter the
// synchronous close+create transaction (planner2's headline finding).
//
// LAZY BY CONSTRUCTION (guard B1): building a context performs ZERO
// reads — the snapshot materializes only when `candidatesForRig()` is
// invoked, which happens exclusively on the tier-3 resolution path
// (AFTER the frontier + absorption guards). Absorbed waiting-replays
// and terminal frontier rejections therefore perform zero
// role-resolution inventory reads; the commit-4 read-spy pins it.
//
// FRESH NAME→ID PER RESOLUTION (arch Q4): the bound rig persists as a
// NAME; each snapshot re-resolves name→id. A vanished rig returns
// null and the caller fails loud (`bound_rig_not_found` class) — WF-5
// catches the failed instance.

import type Database from "better-sqlite3";
import {
  attachTerminalActivityAndWork,
  deriveCanonicalFromEntry,
  getNodeInventory,
} from "./node-inventory.js";
import { selectRoleSeat, type RoleSeatCandidateFacts } from "./workflow-role-resolver.js";
import { RigRepository } from "./rig-repository.js";

/** Two or more UNARCHIVED rigs carry the bound name. Resolution never picks one of them (spec 0009). */
export class RigNameAmbiguousError extends Error {
  constructor(readonly rigName: string, readonly rigIds: string[]) {
    super(`rig name "${rigName}" matches ${rigIds.length} unarchived rigs (${rigIds.join(", ")}); archive or rename the extra rigs, then retry`);
    this.name = "RigNameAmbiguousError";
  }
}

/**
 * Spec 0009: resolve a rig NAME to the one UNARCHIVED rig that carries it, through the archive-aware
 * lookup seat refs already use (#174). Archived rigs are never chosen: a lead swap archives a rig and
 * creates a new one under the same name, and the oldest row is often the archived one. null = no
 * unarchived rig; more than one throws RigNameAmbiguousError.
 */
export function resolveUnarchivedRigId(db: Database.Database, rigName: string): string | null {
  const ids = unarchivedRigIds(db, rigName);
  if (ids.length > 1) throw new RigNameAmbiguousError(rigName, ids);
  return ids[0] ?? null;
}

/**
 * An archived rig answers a probe only when no unarchived rig has the name (upstream #1101, kept beside spec 0009):
 * the unarchived rig always wins, two of them stay ambiguous, and the oldest archived rig is the fallback.
 */
export function resolveRigIdPreferringUnarchived(db: Database.Database, rigName: string): string | null {
  const unarchived = resolveUnarchivedRigId(db, rigName);
  if (unarchived) return unarchived;
  return (db.prepare("SELECT id FROM rigs WHERE name = ? ORDER BY created_at LIMIT 1").get(rigName) as { id: string } | undefined)?.id ?? null;
}

/** The ids of every unarchived rig named `rigName`, oldest first (spec 0009). */
export function unarchivedRigIds(db: Database.Database, rigName: string): string[] {
  return new RigRepository(db).findUnarchivedRigsByName(rigName).map((r) => r.id);
}

/** The distinct names of unarchived rigs, for messages that list what is registered (spec 0009). */
export function unarchivedRigNames(db: Database.Database): string[] {
  const hasArchive = (db.prepare("PRAGMA table_info(rigs)").all() as Array<{ name?: string }>)
    .some((c) => c.name === "archived_at");
  return (db.prepare(`SELECT DISTINCT name FROM rigs${hasArchive ? " WHERE archived_at IS NULL" : ""} ORDER BY name`)
    .all() as Array<{ name: string }>).map((r) => r.name);
}

export interface RoleResolutionContext {
  /** The instance's bound rig NAME (never null — an unbound instance
   *  builds no context at all; tier 3 simply does not exist for it). */
  boundRig: string;
  /**
   * Materialize the candidate-facts snapshot for the bound rig, NOW.
   * null = the bound rig no longer resolves by name (vanished mid-run).
   * Reads happen only when this is called (the guard-B1 laziness pin).
   */
  candidatesForRig: () => RoleSeatCandidateFacts[] | null;
}

/**
 * Build the (lazy) resolution context for a bound instance.
 * Returns undefined for unbound instances so call sites can thread
 * `instance.boundRig` straight through:
 *   `roleResolutionContext(db, instance.boundRig)`
 */
export function roleResolutionContext(
  db: Database.Database,
  boundRig: string | null | undefined,
): RoleResolutionContext | undefined {
  if (!boundRig) return undefined;
  return {
    boundRig,
    candidatesForRig: () => {
      const rigId = resolveRigIdPreferringUnarchived(db, boundRig);
      if (!rigId) return null;
      const entries = attachTerminalActivityAndWork(getNodeInventory(db, rigId), { db });
      return entries.map((e) => ({
        logicalId: e.logicalId,
        role: e.role,
        nodeKind: e.nodeKind,
        lifecycleState: e.lifecycleState,
        runtime: e.runtime,
        pendingWorkCount: e.pendingWorkCount ?? 0,
        coordinate: deriveCanonicalFromEntry(e),
        rawSessionName: e.canonicalSessionName,
      }));
    },
  };
}

/**
 * Resolve `role` on the bound rig, returning null for an evidenced no-match
 * or an unbound/vanished rig. Evidence-read failures propagate: they cannot
 * establish that no eligible agent exists and must not select a human.
 * Each exception item uses a fresh snapshot at its detection moment.
 */
export function tryResolveRoleByCapability(
  ctx: RoleResolutionContext | undefined,
  role: string,
  harness?: string,
): string | null {
  if (!ctx) return null;
  let candidates: RoleSeatCandidateFacts[] | null;
  try {
    candidates = ctx.candidatesForRig();
  } catch (err) {
    // Exception routing: an ambiguous rig name is no capability match, so the caller falls through
    // to its human fallback instead of picking one of the rigs (spec 0009).
    if (err instanceof RigNameAmbiguousError) return null;
    throw err;
  }
  if (!candidates) return null;
  return selectRoleSeat({ role, harness, candidates }).seat;
}

/**
 * The STRUCTURAL role-coverage probe (arch Q2 / guard B1): does ANY
 * seat on the bound rig declare `role`, at ANY lifecycle state?
 * Existence, not liveness — instantiate hard-fails only on ZERO
 * structural coverage (a typo'd/undeclared role), never on a
 * not-yet-running seat (factory rigs warm up; liveness is that step's
 * own projection-time concern).
 */
export function rigDeclaresRole(
  db: Database.Database,
  boundRig: string,
  role: string,
): boolean {
  const rigId = resolveUnarchivedRigId(db, boundRig);
  if (!rigId) return false;
  const row = db
    .prepare(`SELECT COUNT(*) as c FROM nodes WHERE rig_id = ? AND role = ?`)
    .get(rigId, role) as { c: number };
  return row.c > 0;
}

/**
 * OPR.0.4.6.FAC3 (FR-5): the structural MEMBER-EXISTS probe — does any
 * member of `rigName` derive the canonical coordinate `sessionRef`?
 *
 * Existence at ANY lifecycle state and ANY node kind (`rigDeclaresRole`'s
 * sibling discipline): a declared-but-not-yet-launched seat, or a
 * terminal member explicitly named as a preferred_target, is a
 * legitimate destination — liveness/kind is projection's business, not
 * this probe's. The compare is the DERIVED canonical coordinate
 * `{pod}-{member}@{rig}` via the same derivation tier-3 candidates use
 * (the FAC-1 Q5 one-string rule — a raw occupant-era session name never
 * participates). Sync SQL only; an unknown rig name returns false (the
 * caller's registered-rig skip runs first, so that case never reaches
 * an advisory here). Throws RigNameAmbiguousError when two unarchived rigs share the
 * name (spec 0009). MAY THROW on a partial-schema DB (the inventory
 * projection reads tables like `snapshots`) — the FR-5 sweep treats a
 * throw as cannot-vouch and skips (advisory-never-throw; VM-caught run-1).
 */
export function rigMemberExists(
  db: Database.Database,
  rigName: string,
  sessionRef: string,
): boolean {
  const rigId = resolveRigIdPreferringUnarchived(db, rigName);
  if (!rigId) return false;
  return getNodeInventory(db, rigId).some(
    (e) => deriveCanonicalFromEntry(e) === sessionRef,
  );
}
