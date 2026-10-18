const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

/** Spec 0014 and CER-2981: the command that removes one edge of a stored cycle, named the same way by restore and by a
 *  growth refusal. */
export function edgeRemovalCommand(rigId: string): string {
  return `rig edge remove ${rigId} <from> <to> --kind <kind>`;
}

/** An edge as stored: `from <kind> to`. */
export interface LaunchGraphEdge {
  from: string;
  to: string;
  kind: string;
}

/**
 * Spec 0014: the nodes of a launch-dependency graph that no launch order can place (delegates_to: source first;
 * spawned_by: target first), each with the stored edges of every cycle at or upstream of it, sorted by label.
 * Empty when the graph is acyclic. Edges with an end outside `nodes` are ignored, as the launch-order sorts ignore them.
 */
export function heldByLaunchCycles(nodes: readonly string[], edges: readonly LaunchGraphEdge[]): Map<string, LaunchGraphEdge[]> {
  const known = new Set(nodes);
  const deps = edges
    .filter((edge) => LAUNCH_DEPENDENCY_KINDS.has(edge.kind) && known.has(edge.from) && known.has(edge.to))
    .map((edge) => edge.kind === "delegates_to"
      ? { first: edge.from, then: edge.to, edge }
      : { first: edge.to, then: edge.from, edge });

  // Whatever never reaches in-degree 0 cannot be ordered.
  const inDegree = new Map([...known].map((id) => [id, 0]));
  for (const dep of deps) inDegree.set(dep.then, inDegree.get(dep.then)! + 1);
  const placed = [...known].filter((id) => inDegree.get(id) === 0);
  for (let i = 0; i < placed.length; i++) {
    for (const dep of deps) {
      if (dep.first !== placed[i]) continue;
      inDegree.set(dep.then, inDegree.get(dep.then)! - 1);
      if (inDegree.get(dep.then) === 0) placed.push(dep.then);
    }
  }
  const placedSet = new Set(placed);
  const held = [...known].filter((id) => !placedSet.has(id));
  const heldDeps = deps.filter((dep) => !placedSet.has(dep.first) && !placedSet.has(dep.then));

  // Nodes each held node reaches through one or more edges; an edge lies on a cycle when its head reaches its tail.
  const reach = new Map(held.map((id) => {
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dep of heldDeps) {
        if (dep.first === current && !seen.has(dep.then)) { seen.add(dep.then); stack.push(dep.then); }
      }
    }
    return [id, seen];
  }));
  const cycleDeps = heldDeps.filter((dep) => reach.get(dep.then)!.has(dep.first));
  const label = (edge: LaunchGraphEdge) => `${edge.from} ${edge.kind} ${edge.to}`;
  return new Map(held.map((id) => [id, cycleDeps
    .filter((dep) => dep.first === id || reach.get(dep.first)!.has(id))
    .map((dep) => dep.edge)
    .sort((a, b) => label(a).localeCompare(label(b)))]));
}

/** "a delegates_to b, c spawned_by d": stored edges as named in refusals and held-seat reasons, sorted, unique. */
export function describeLaunchEdges(edges: readonly LaunchGraphEdge[]): string {
  return [...new Set(edges.map((edge) => `${edge.from} ${edge.kind} ${edge.to}`))].sort().join(", ");
}
