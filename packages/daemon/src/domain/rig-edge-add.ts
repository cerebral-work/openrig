// Spec 0008: add one edge between two EXISTING nodes of a rig. `rig expand` takes cross-pod edges
// only for the pod it adds, and `rig add` only pod-local ones, so an edge between seats that already
// exist (a rig expanded pod by pod) had no supported path. Only an edge row is written: no node,
// session or binding changes, so the rig ID and every seat's conversation are kept.
import type { RigRepository } from "./rig-repository.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";
import type { Edge } from "./types.js";

export type AddRigEdgeResult =
  | { ok: true; status: "created" | "exists"; edge: Edge }
  | { ok: false; code: "rig_not_found" | "rig_archived" | "node_not_found" | "invalid_kind"; error: string };

export function addRigEdge(
  rigRepo: RigRepository,
  input: { rigId: string; from: string; to: string; kind: string },
): AddRigEdgeResult {
  const rig = rigRepo.getRig(input.rigId);
  if (!rig) return { ok: false, code: "rig_not_found", error: `Rig ${input.rigId} not found` };
  if (!rigRepo.findUnarchivedRigsByName(rig.rig.name).some((r) => r.id === input.rigId)) {
    return { ok: false, code: "rig_archived", error: `Rig ${input.rigId} is archived; edges are added to live rigs only` };
  }
  if (!VALID_EDGE_KINDS.has(input.kind)) {
    return { ok: false, code: "invalid_kind", error: `Unknown edge kind "${input.kind}" (valid: ${[...VALID_EDGE_KINDS].join(", ")})` };
  }
  const byLogicalId = new Map(rig.nodes.map((n) => [n.logicalId, n]));
  const source = byLogicalId.get(input.from);
  const target = byLogicalId.get(input.to);
  if (!source || !target) {
    const missing = [source ? null : input.from, target ? null : input.to].filter(Boolean).join(" and ");
    return { ok: false, code: "node_not_found", error: `No node ${missing} in rig ${input.rigId}` };
  }
  const existing = rig.edges.find((e) => e.sourceId === source.id && e.targetId === target.id && e.kind === input.kind);
  if (existing) return { ok: true, status: "exists", edge: existing };
  return { ok: true, status: "created", edge: rigRepo.addEdge(input.rigId, source.id, target.id, input.kind) };
}
