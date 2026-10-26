// Spec 0008: add one edge between two EXISTING nodes of a rig. `rig expand` takes cross-pod edges
// only for the pod it adds, and `rig add` only pod-local ones, so an edge between seats that already
// exist (a rig expanded pod by pod) had no supported path. Only an edge row is written: no node,
// session or binding changes, so the rig ID and every seat's conversation are kept. Like the spec path,
// it refuses a self-edge and a launch-dependency edge that closes a cycle: restore would drop those nodes.
import type { RigRepository } from "./rig-repository.js";
import type { EventBus } from "./event-bus.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";
import { addRigEdge as addRigEdgeOp, type EdgeOpOutcome } from "./rig-edge-ops.js";
import type { Edge } from "./types.js";

/** Spec 0008 / CER-3001: add one edge and record rig.edge_added in the insert's transaction. The checks, the idempotent
 *  repeat and the write are `rig-edge-ops`'s, the one path the POST route also takes. */
export function addRigEdge(
  rigRepo: RigRepository,
  eventBus: EventBus,
  input: { rigId: string; from: string; to: string; kind: string; by: { session: string; provenance: string } | null },
): EdgeOpOutcome {
  return addRigEdgeOp(rigRepo, { rigId: input.rigId, from: input.from, to: input.to, kind: input.kind, record: { eventBus, by: input.by } });
}

export type RemoveRigEdgeResult =
  | { ok: true; status: "removed"; edges: Edge[] }
  | { ok: false; code: "rig_not_found" | "rig_archived" | "node_not_found" | "invalid_kind" | "edge_not_found"; error: string };

/** CER-2981 (spec 0008): remove an edge between two nodes of a live rig, the reverse of `addRigEdge`, with the same checks
 *  in the same order. An edge's identity to the operator is (from, to, kind), so every row matching it is deleted (a
 *  database without CER-3002's unique index can hold duplicates), each with its own `rig.edge_removed` event naming the caller, in one transaction; no node,
 *  session, binding or pane changes. No matching row is `edge_not_found`, never success. A removed `delegates_to` edge
 *  stops counting for queue-owner routing and `rig whoami` at once. */
export function removeRigEdge(
  rigRepo: RigRepository,
  eventBus: EventBus,
  input: { rigId: string; from: string; to: string; kind: string; by: { session: string; provenance: string } | null },
): RemoveRigEdgeResult {
  const rig = rigRepo.getRig(input.rigId);
  if (!rig) return { ok: false, code: "rig_not_found", error: `Rig ${input.rigId} not found` };
  if (!rigRepo.findUnarchivedRigsByName(rig.rig.name).some((r) => r.id === input.rigId)) {
    return { ok: false, code: "rig_archived", error: `Rig ${input.rigId} is archived; edges are removed from live rigs only` };
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
  const notFound = { ok: false, code: "edge_not_found", error: `No ${input.kind} edge ${input.from} -> ${input.to} in rig ${input.rigId}` } as const;
  const matching = rig.edges.filter((e) => e.sourceId === source.id && e.targetId === target.id && e.kind === input.kind);
  if (matching.length === 0) return notFound;
  // A row another caller deleted between the read and this transaction is skipped, with no event for it.
  const removed = rigRepo.db.transaction(() => matching.flatMap((edge) => rigRepo.removeEdgeById(edge.id)
    ? [{ edge, event: eventBus.persistWithinTransaction({ type: "rig.edge_removed", rigId: input.rigId, edgeId: edge.id,
      from: input.from, to: input.to, kind: input.kind, by: input.by }) }]
    : []))();
  if (removed.length === 0) return notFound;
  for (const { event } of removed) eventBus.notifySubscribers(event);
  return { ok: true, status: "removed", edges: removed.map(({ edge }) => edge) };
}
