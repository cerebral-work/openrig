// Spec 0008: add one edge between two EXISTING nodes of a rig. `rig expand` takes cross-pod edges
// only for the pod it adds, and `rig add` only pod-local ones, so an edge between seats that already
// exist (a rig expanded pod by pod) had no supported path. Only an edge row is written: no node,
// session or binding changes, so the rig ID and every seat's conversation are kept. Like the spec path,
// it refuses a self-edge and a launch-dependency edge that closes a cycle: restore would drop those nodes.
import type { RigRepository } from "./rig-repository.js";
import type { EventBus } from "./event-bus.js";
import { VALID_EDGE_KINDS } from "./rigspec-schema.js";
import { computeLaunchOrder } from "./rigspec-instantiator.js";
import type { Edge } from "./types.js";

export type AddRigEdgeResult =
  | { ok: true; status: "created" | "exists"; edge: Edge }
  | { ok: false; code: "rig_not_found" | "rig_archived" | "node_not_found" | "invalid_kind" | "self_edge" | "cycle"; error: string };

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
  if (source.id === target.id) {
    return { ok: false, code: "self_edge", error: `Self-edge not allowed: ${input.from} -> ${input.to}` };
  }
  const existing = rig.edges.find((e) => e.sourceId === source.id && e.targetId === target.id && e.kind === input.kind);
  if (existing) return { ok: true, status: "exists", edge: existing };
  const logicalById = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
  const edges = rig.edges.flatMap((e) => {
    const from = logicalById.get(e.sourceId);
    const to = logicalById.get(e.targetId);
    return from && to ? [{ from, to, kind: e.kind }] : [];
  });
  try {
    computeLaunchOrder(rig.nodes.map((n) => ({ id: n.logicalId })), [...edges, { from: input.from, to: input.to, kind: input.kind }]);
  } catch (err) {
    return { ok: false, code: "cycle", error: `Edge ${input.from} -> ${input.to} (${input.kind}) would close a launch-order cycle. ${(err as Error).message}` };
  }
  return { ok: true, status: "created", edge: rigRepo.addEdge(input.rigId, source.id, target.id, input.kind) };
}

export type RemoveRigEdgeResult =
  | { ok: true; status: "removed"; edges: Edge[] }
  | { ok: false; code: "rig_not_found" | "rig_archived" | "node_not_found" | "invalid_kind" | "edge_not_found"; error: string };

/** CER-2981 (spec 0008): remove an edge between two nodes of a live rig, the reverse of `addRigEdge`, with the same checks
 *  in the same order. An edge's identity to the operator is (from, to, kind), so every row matching it is deleted (the
 *  table allows duplicates), each with its own `rig.edge_removed` event naming the caller, in one transaction; no node,
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
  const removed = rigRepo.db.transaction(() => matching.flatMap((edge) => rigRepo.removeEdge(edge.id)
    ? [{ edge, event: eventBus.persistWithinTransaction({ type: "rig.edge_removed", rigId: input.rigId, edgeId: edge.id,
      from: input.from, to: input.to, kind: input.kind, by: input.by }) }]
    : []))();
  if (removed.length === 0) return notFound;
  for (const { event } of removed) eventBus.notifySubscribers(event);
  return { ok: true, status: "removed", edges: removed.map(({ edge }) => edge) };
}
